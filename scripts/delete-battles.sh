#!/usr/bin/env bash
# delete-battles.sh — 1 引数 (StackName) を受け取って CFn DeleteStack + Wait する。
# deploy-battles.sh と対称な操作。MVP-1 は same-account なので CodeBuild Project Role
# が直接 CFn DeleteStack 権限を持つ。Phase 2 (cross-account) では sts:AssumeRole に
# 差し替える。

set -euo pipefail

# shellcheck source=lib/battles-common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/battles-common.sh"

case "${LC_ALL:-${LANG:-}}" in
  C|POSIX|"")
    export LANG="en_US.UTF-8"
    export LC_ALL="en_US.UTF-8"
    ;;
esac

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <stack-name-or-arn> [<region>]" >&2
  exit 1
fi

STACK_NAME="$1"
# 第 2 引数 > AWS_REGION env > aws cli config の順 (resolve_aws_region は env/cli config を見る)。
REGION="${2:-$(resolve_aws_region)}"

# Phase 2.2 (Issue #459): cross-account 化。`COMPETITOR_ROLE_ARN` が set されていれば
# AssumeRole + ExternalId で tmp credentials に切り替える。
# DEPLOY_REGION も export し直す (delete でも target region を AssumeRole 後に固定する)。
export DEPLOY_REGION="${REGION}"
assume_competitor_role_if_configured
trace_log "deploy.codebuild.start" operation "delete" region "${REGION}" stackName "${STACK_NAME}"

echo "=========================================="
echo "Deleting stack"
echo "  StackName : ${STACK_NAME}"
echo "  Region    : ${REGION}"
echo "=========================================="
trace_log "deploy.cfn.delete.start" stackName "${STACK_NAME}" region "${REGION}"

# DeleteStack 自体が冪等 (削除済み stack に対して呼んでも ValidationError を返すだけで
# 既存リソースに影響なし)。pre-check の describe-stacks は TOCTOU race を生む (= check と
# delete の間に他 actor が消すと describe は OK でも delete が ValidationError) ので入れない。
# 直接 delete-stack → 既に削除済みなら "does not exist" を握って no-op exit、それ以外は loud に fail。
# #1381: same-account 経路では deploy 時と同じ CFn service role を渡す (= CodeBuild role から
# 直接の resource 削除権限を剥がした分、 CFn がこの role を assume して削除する)。 cross-account 経路は
# assumed competitor role の権限で動くため --role-arn は付けない。
cfn_delete_role_args=()
if [[ -z "${COMPETITOR_ROLE_ARN:-}" && -n "${CFN_EXEC_ROLE_ARN:-}" ]]; then
  cfn_delete_role_args=(--role-arn "${CFN_EXEC_ROLE_ARN}")
fi
delete_err="$(
  aws cloudformation delete-stack \
    --region "${REGION}" \
    --stack-name "${STACK_NAME}" \
    ${cfn_delete_role_args[@]+"${cfn_delete_role_args[@]}"} 2>&1
)" || {
  if grep -qiE "ValidationError|does not exist" <<<"${delete_err}"; then
    trace_log "deploy.cfn.delete.already_deleted" stackName "${STACK_NAME}" region "${REGION}"
    echo "Stack ${STACK_NAME} は既に存在しない (already deleted) → no-op で終了"
    exit 0
  fi
  trace_log "deploy.cfn.delete.failed" stackName "${STACK_NAME}" region "${REGION}"
  echo "error: delete-stack failed (auth/throttle/network 等を疑う): ${delete_err}" >&2
  exit 1
}

# DeleteStack は async。完了 (= DescribeStacks が ValidationError を返す) まで wait。
# 60 minutes timeout (CodeBuild Project の build timeout と揃える)。
# 既削除の race (wait より先に消えた) も ValidationError として握る。
wait_err="$(
  aws cloudformation wait stack-delete-complete \
    --region "${REGION}" \
    --stack-name "${STACK_NAME}" 2>&1
)" || {
  if grep -qiE "ValidationError|does not exist" <<<"${wait_err}"; then
    trace_log "deploy.cfn.delete.already_deleted" stackName "${STACK_NAME}" region "${REGION}"
    echo "Stack ${STACK_NAME} は既に削除済 (wait の前に消えた) → no-op で終了"
    exit 0
  fi
  trace_log "deploy.cfn.delete.failed" stackName "${STACK_NAME}" region "${REGION}"
  echo "error: wait stack-delete-complete failed: ${wait_err}" >&2
  exit 1
}

echo ""
trace_log "deploy.cfn.delete.succeeded" stackName "${STACK_NAME}" region "${REGION}"
trace_log "deploy.codebuild.succeeded" operation "delete" region "${REGION}" stackName "${STACK_NAME}"
echo "Stack ${STACK_NAME} deleted (region=${REGION})."
