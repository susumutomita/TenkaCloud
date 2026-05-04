#!/bin/bash
set -eo pipefail
# TenkaCloud cleanup: 全 stack + S3 bucket を冪等に破棄する。
# どの状態 (全 deploy 済 / 途中失敗 / 既に一部削除済 / 未 deploy) からでも動く。
#
# Usage:
#   make destroy                 # Makefile 経由 (ENV=development)
#   ENV=production bash scripts/cleanup.sh
#
# 前提:
#   - aws CLI がログイン済み
#   - infrastructure/environments/${ENV}/.env が存在し SYSTEM_ADMIN_EMAIL を持つ

log() { echo "[$(date +%H:%M:%S)] $*"; }

# versioned bucket を完全に空にする。`aws s3 rm --recursive` は current version
# しか消さない → `aws s3 rb --force` が BucketNotEmpty で落ちる。versions と
# delete markers を全部列挙して delete-objects で消す。
empty_versioned_bucket() {
  local bucket="$1"
  if ! aws s3api head-bucket --bucket "$bucket" >/dev/null 2>&1; then
    return 0
  fi
  log "  empty versioned s3://${bucket}"
  while :; do
    local payload
    payload=$(aws s3api list-object-versions --bucket "$bucket" --max-items 1000 --output json 2>/dev/null \
      | jq -c '{Objects: ((.Versions // []) + (.DeleteMarkers // [])) | map({Key: .Key, VersionId: .VersionId}), Quiet: true}')
    local count
    count=$(echo "$payload" | jq '.Objects | length')
    if [[ "$count" == "0" ]]; then
      break
    fi
    echo "$payload" | aws s3api delete-objects --bucket "$bucket" --delete file:///dev/stdin >/dev/null
  done
}

TenkaCloud_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV="${ENV:-development}"
ENV_FILE="${TenkaCloud_ROOT}/infrastructure/environments/${ENV}/.env"

if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

if [[ -z "${SYSTEM_ADMIN_EMAIL:-}" ]]; then
  echo "ERROR: SYSTEM_ADMIN_EMAIL is not set (check ${ENV_FILE})" >&2
  exit 1
fi

export REGION="$(aws configure get region)"
export ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
SOURCE_BUCKET="serverless-saas-${ACCOUNT_ID}-${REGION}"

# bin/infrastructure.ts が CDK_PARAM_* を要求し、fromBucketName は DNS 検証で短い値だと synth が落ちる。
# shell に残る empty/"NA" 等の汚染が export を貫通した実害があったので unset → export の順で衛生化。
unset CDK_PARAM_SYSTEM_ADMIN_EMAIL CDK_PARAM_S3_BUCKET_NAME CDK_SOURCE_NAME CDK_PARAM_COMMIT_ID
export CDK_PARAM_SYSTEM_ADMIN_EMAIL="${SYSTEM_ADMIN_EMAIL}"
export CDK_PARAM_S3_BUCKET_NAME="${SOURCE_BUCKET}"
export CDK_SOURCE_NAME="source.zip"
export CDK_PARAM_COMMIT_ID="destroy"
export JSII_DEPRECATED="quiet"

cd "${TenkaCloud_ROOT}/infrastructure"
if [[ ! -d node_modules ]]; then
  log "bun install..."
  bun install
fi

# 非空 bucket が残ると stack 削除が DELETE_FAILED で連鎖するので先に空にする。
# autoDeleteObjects 付きも保険で含める。
log "emptying related buckets (including all versions / delete markers)..."
bucket_patterns="^${SOURCE_BUCKET}$|^serverlesssaaspipeline-artifactsbucket-|^controlplanestack-staticsitedistrostaticsitedistr-|^serverless-saas-ref-arch-serverlesssaasrefarchten-|^adminconsolehostingstack-"
while IFS= read -r bucket; do
  empty_versioned_bucket "$bucket"
done < <(aws s3 ls 2>/dev/null | awk '{print $3}' | grep -E "$bucket_patterns" || true)

# Note: ProtoShip 由来の per-app auth-proxy Lambda の orphan sweep は TenkaCloud
# では不要 (auth-proxy 機能を撤去したため、`TenkaCloud-app-*` 命名の runtime
# 生成 Lambda は存在しない)。GameDay deploy pipeline で生成される CFn stack は
# CFn 管理下なので cdk destroy --all で消える。

# AdminConsoleHostingStack は bin/infrastructure.ts が CDK_PARAM_CONTROL_PLANE_* と
# apps/admin-console/dist/ を要求するため cdk destroy では synth が落ちる。CFN 直 delete で迂回。
if aws cloudformation describe-stacks --stack-name AdminConsoleHostingStack >/dev/null 2>&1; then
  log "deleting AdminConsoleHostingStack via CloudFormation..."
  aws cloudformation delete-stack --stack-name AdminConsoleHostingStack
  # wait は timeout / DELETE_FAILED の両方で non-zero。どちらも後段の cdk destroy --all が
  # 再試行 + CFN エラーを surface するので、ここでは warn だけで先に進める。
  aws cloudformation wait stack-delete-complete --stack-name AdminConsoleHostingStack \
    || log "  stack-delete wait did not succeed; later steps will surface the cause"
else
  log "AdminConsoleHostingStack not found; skip"
fi

# 動的 tenant stack (pipeline 経由で provision された tenant 単位 stack) を先に destroy。
# pooled は CDK app 内なので最後の cdk destroy --all で一緒に消える。
log "checking for dynamic tenant stacks..."
STACK_FILTER=(
  CREATE_COMPLETE ROLLBACK_COMPLETE
  UPDATE_COMPLETE UPDATE_ROLLBACK_COMPLETE
  IMPORT_COMPLETE IMPORT_ROLLBACK_COMPLETE
)
tenant_stacks=$(aws cloudformation list-stacks \
  --stack-status-filter "${STACK_FILTER[@]}" \
  --query "StackSummaries[?starts_with(StackName, 'serverless-saas-ref-arch-tenant-template-') && StackName != 'serverless-saas-ref-arch-tenant-template-pooled'].StackName" \
  --output text)
for stack_name in $tenant_stacks; do
  tenant_id="${stack_name#serverless-saas-ref-arch-tenant-template-}"
  log "  destroying ${stack_name} (tenant_id=${tenant_id})"
  CDK_PARAM_TENANT_ID="$tenant_id" bunx cdk destroy "$stack_name" --force \
    || log "    skip (already gone or conflict)"
done

log "cdk destroy --all (backend stacks)..."
bunx cdk destroy --all --force || log "  (some stacks not destroyed; review AWS console)"

# install.sh が作る source bucket は CDK 管理外なので手動で空 → delete-bucket。
log "removing source bucket ${SOURCE_BUCKET}..."
if aws s3api head-bucket --bucket "${SOURCE_BUCKET}" --expected-bucket-owner "${ACCOUNT_ID}" 2>/dev/null; then
  empty_versioned_bucket "${SOURCE_BUCKET}"
  aws s3api delete-bucket --bucket "${SOURCE_BUCKET}"
  log "  removed"
else
  log "  (already gone)"
fi

log "cleanup complete."
