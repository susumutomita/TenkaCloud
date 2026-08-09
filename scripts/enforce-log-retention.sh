#!/usr/bin/env bash
#
# Backstop for log groups nothing in CDK can configure (#2960).
#
# ## Why this exists
#
# `LogGroupRetention` only reaches `CfnLogGroup` — log groups that exist in the synth
# output. A Lambda without an explicit log group gets one created by the Lambda service
# on first invocation, which never appears in a template, so the aspect never sees it and
# the group defaults to **Never expire**.
#
# On 2026-08-08, 48 log groups survived `make destroy-saas` and **29 of them had no
# retention at all** — the storage bill for those runs forever. That is the part worth
# fixing even when the cleanup sweep is working: a group that is going to be deleted
# eventually still costs money in the meantime, and a group that is missed costs money
# for good.
#
# Most call sites are fixed at construction (`deploymentLogGroup` gives every
# `BucketDeployment` an explicit group). **Two paths cannot be**, because the construct
# creates its provider Lambda internally as a singleton and exposes no log configuration
# (verified against the type definitions in aws-cdk-lib 2.262.1):
#
#   Custom::S3AutoDeleteObjects          from `Bucket({ autoDeleteObjects: true })`
#   Custom::AWSCDKOpenIdConnectProvider  from `iam.OpenIdConnectProvider`
#
# plus the CodeBuild projects SBT creates. This script is what covers those. It is a
# backstop, not the fix — "we closed all of it" would not be true.
#
# ## What it will not touch
#
# Only log groups whose name contains `tenkacloud`, or that sit under one of the SBT
# CodeBuild prefixes this platform creates. An account runs other things; a retention
# sweep that guessed would silently shorten somebody else's retention, and nothing about
# that failure would be visible until the logs were needed and gone.
#
# Groups that already have a retention are left exactly as they are. This only fills in
# the null.
#
# Usage:
#   bash scripts/enforce-log-retention.sh            # apply
#   DRY_RUN=1 bash scripts/enforce-log-retention.sh  # report only
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${ENV_FILE:-${REPO_ROOT}/.env}"

log() { printf '%s\n' "$*"; }

# `CDK_PARAM_LOG_RETENTION_DAYS` is the same source of truth the aspect reads. Reading it
# from `.env` here rather than hardcoding a number keeps one knob for both paths.
if [ -f "${ENV_FILE}" ]; then
  # shellcheck disable=SC1090
  RETENTION_FROM_ENV="$(grep -E '^CDK_PARAM_LOG_RETENTION_DAYS=' "${ENV_FILE}" | tail -n 1 | cut -d= -f2- | tr -d '"'"'" || true)"
else
  RETENTION_FROM_ENV=""
fi
RETENTION_DAYS="${CDK_PARAM_LOG_RETENTION_DAYS:-${RETENTION_FROM_ENV:-1}}"

case "${RETENTION_DAYS}" in
  1|3|5|7|14|30|60|90|120|150|180|365|400|545|731|1096|1827|2192|2557|2922|3288|3653) ;;
  *)
    log "CDK_PARAM_LOG_RETENTION_DAYS=${RETENTION_DAYS} is not a retention CloudWatch accepts." >&2
    log "Use one of: 1 3 5 7 14 30 60 90 120 150 180 365 400 545 731 1096 1827 2192 2557 2922 3288 3653" >&2
    exit 2
    ;;
esac

# Same three families the cleanup sweep uses, for the same reason: these are what this
# platform creates, and nothing else is ours to change.
LOG_GROUP_PREFIXES=(
  "/aws/lambda/tenkacloud"
  "tenkacloud-"
  "/aws/codebuild/provisioningJobRunner"
  "/aws/codebuild/deprovisioningJobRunner"
  "/aws/codebuild/CdkCodeBuildProject"
)

log "enforcing retention=${RETENTION_DAYS} on tenkacloud log groups with none set..."
UPDATED=0
SKIPPED=0
FAILURES=()

for lg_prefix in "${LOG_GROUP_PREFIXES[@]}"; do
  # `retentionInDays == null` is the whole selection: groups that already have a policy
  # are somebody's decision and are left alone.
  names=$(aws logs describe-log-groups --log-group-name-prefix "${lg_prefix}" \
    --query 'logGroups[?retentionInDays==`null`].logGroupName' --output text 2>/dev/null || true)
  for lg_name in ${names}; do
    case "${lg_prefix}" in
      /aws/codebuild/*)
        ;;
      *)
        case "${lg_name}" in
          *tenkacloud*|*TenkaCloud*) ;;
          *) continue ;;
        esac
        ;;
    esac
    if [ "${DRY_RUN:-0}" = "1" ]; then
      log "  would set retention=${RETENTION_DAYS} on ${lg_name}"
      SKIPPED=$((SKIPPED + 1))
      continue
    fi
    log "  setting retention=${RETENTION_DAYS} on ${lg_name}"
    if aws logs put-retention-policy --log-group-name "${lg_name}" \
      --retention-in-days "${RETENTION_DAYS}" >/dev/null 2>&1; then
      UPDATED=$((UPDATED + 1))
    else
      # 失敗を握り潰さない (#2934 の流儀)。 一件でも残れば無期限保持のまま課金が続く。
      log "    FAILED to set retention on ${lg_name}"
      FAILURES+=("${lg_name}")
    fi
  done
done

if [ "${DRY_RUN:-0}" = "1" ]; then
  log "dry run: ${SKIPPED} log group(s) would be updated."
  exit 0
fi

log "retention applied to ${UPDATED} log group(s)."

if [ ${#FAILURES[@]} -gt 0 ]; then
  log "FAILED to set retention on ${#FAILURES[@]} log group(s):" >&2
  for name in "${FAILURES[@]}"; do log "  ${name}" >&2; done
  exit 1
fi
