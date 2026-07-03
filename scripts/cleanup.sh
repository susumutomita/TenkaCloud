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
# Bucket-name construction is centralized in scripts/lib/names.sh (#2194). The real
# deployed bucket is the per-environment HASHED form; the legacy no-hash name only
# lingers from pre-#1749 deploys. Sweep BOTH at teardown so neither is orphaned.
# shellcheck source=lib/names.sh
source "${TenkaCloud_ROOT}/scripts/lib/names.sh"
SOURCE_BUCKET="$(tc_source_bucket_legacy_name "${ACCOUNT_ID}" "${REGION}")"
SOURCE_BUCKET_CANONICAL="$(tc_source_bucket_name "${ACCOUNT_ID}" "${REGION}" "${ENV:-development}")"

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
bucket_prefix_patterns=(
  "^${SOURCE_BUCKET}$"
  "^tenkacloud-saas-pipeline-artifactsbucket-"
  "^tenkacloud-control-plane-staticsitedistrostaticsitedistr-"
  "^tenkacloud-tenant-template-"
  "^tenkacloud-admin-console-hosting-"
)
bucket_patterns=$(IFS='|'; echo "${bucket_prefix_patterns[*]}")
while IFS= read -r bucket; do
  empty_versioned_bucket "$bucket"
done < <(aws s3 ls 2>/dev/null | awk '{print $3}' | grep -E "$bucket_patterns" || true)

# Note: ProtoShip 由来の per-app auth-proxy Lambda の orphan sweep は TenkaCloud
# では不要 (auth-proxy 機能を撤去したため、`TenkaCloud-app-*` 命名の runtime
# 生成 Lambda は存在しない)。GameDay deploy pipeline で生成される CFn stack は
# CFn 管理下なので cdk destroy --all で消える。

# tenkacloud-admin-console-hosting は bin/infrastructure.ts が CDK_PARAM_CONTROL_PLANE_* と
# apps/admin-console/dist/ を要求するため cdk destroy では synth が落ちる。CFN 直 delete で迂回。
if aws cloudformation describe-stacks --stack-name tenkacloud-admin-console-hosting >/dev/null 2>&1; then
  log "deleting tenkacloud-admin-console-hosting via CloudFormation..."
  aws cloudformation delete-stack --stack-name tenkacloud-admin-console-hosting
  # wait は timeout / DELETE_FAILED の両方で non-zero。どちらも後段の cdk destroy --all が
  # 再試行 + CFN エラーを surface するので、ここでは warn だけで先に進める。
  aws cloudformation wait stack-delete-complete --stack-name tenkacloud-admin-console-hosting \
    || log "  stack-delete wait did not succeed; later steps will surface the cause"
else
  log "tenkacloud-admin-console-hosting not found; skip"
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
  --query "StackSummaries[?starts_with(StackName, 'tenkacloud-tenant-template-') && StackName != 'tenkacloud-tenant-template-pooled'].StackName" \
  --output text)
for stack_name in $tenant_stacks; do
  tenant_id="${stack_name#tenkacloud-tenant-template-}"
  log "  destroying ${stack_name} (tenant_id=${tenant_id})"
  CDK_PARAM_TENANT_ID="$tenant_id" bun cdk destroy "$stack_name" --force \
    || log "    skip (already gone or conflict)"
done

log "cdk destroy --all (backend stacks)..."
bun cdk destroy --all --force || log "  (some stacks not destroyed; review AWS console)"

# install.sh が作る source bucket は CDK 管理外なので手動で空 → delete-bucket。
# 実デプロイは HASHED 形式を作るが、pre-#1749 の legacy 形式が残っている環境もあるので
# 両形式を掃く (#2194)。 存在しない bucket は head-bucket が falsy = no-op で安全。
for source_bucket in "${SOURCE_BUCKET_CANONICAL}" "${SOURCE_BUCKET}"; do
  log "removing source bucket ${source_bucket}..."
  if aws s3api head-bucket --bucket "${source_bucket}" --expected-bucket-owner "${ACCOUNT_ID}" 2>/dev/null; then
    empty_versioned_bucket "${source_bucket}"
    aws s3api delete-bucket --bucket "${source_bucket}"
    log "  removed"
  else
    log "  (already gone)"
  fi
done

# SBT ref-arch の API Key (`server-Basic-*` / `server-Stand-*` / `server-Premi-*` /
# `server-Plati-*`、 旧 stack 名 prefix が CFn 上のリソース名に焼かれている) と
# tenkacloud- prefix の現行 API Key を残骸チェック。 CFn 管理下なら destroy で消えるが、
# 過去の partial-rollback で stack だけ削除済 + API Key 残存というケースを救う。
# 同名 API key が複数 region にまたがる可能性は低いので current region のみ scan。
# 旧コードが LogGroup を hardcoded 名で作っていた残骸を削除 (= #653 / StepFunctionLogging 経路)。
# 現在は CFn auto-name に切替済だが、 過去 deploy の残骸が出てくると AlreadyExists で 2 回目 deploy が落ちる。
log "scanning for orphan LogGroups (legacy hardcoded names)..."
for orphan_lg in "/aws/vendedlogs/states/StepFunctionLogging"; do
  if aws logs describe-log-groups --log-group-name-prefix "${orphan_lg}" --query 'logGroups[?logGroupName==`'"${orphan_lg}"'`].logGroupName' --output text 2>/dev/null | grep -q .; then
    log "  deleting orphan log group ${orphan_lg}"
    aws logs delete-log-group --log-group-name "${orphan_lg}" 2>/dev/null \
      || log "    skip (already gone or in-use)"
  fi
done

# SSM Parameter Store の per-tenant ExternalId (= `/{env}/tenants/{tenantId}/external-id`)
# は competitor-accounts handler が runtime で `PutParameterCommand` で書き込む (= CFn 管理外)
# ため `cdk destroy` で消えない (= make destroy 後にも SecureString が残骸として残る)。
# orphan API key と同じ pattern で env scope (`/${ENV}/tenants/`) を走査し削除する。
# 対象は SecureString だが describe-parameters は `Type=SecureString` 自体を返さない
# ので filter は不要、 命名規約 (`ends_with(Name, '/external-id')`) で同定する。
log "scanning for orphan SSM parameters (per-tenant ExternalId SecureStrings)..."
ORPHAN_PARAMS=$(aws ssm describe-parameters \
  --parameter-filters "Key=Name,Option=BeginsWith,Values=/${ENV}/tenants/" \
  --query "Parameters[?ends_with(Name, '/external-id')].Name" \
  --output text 2>/dev/null || true)
if [ -n "${ORPHAN_PARAMS}" ]; then
  for param_name in ${ORPHAN_PARAMS}; do
    log "  deleting orphan SSM parameter ${param_name}"
    aws ssm delete-parameter --name "${param_name}" 2>/dev/null \
      || log "    skip (already gone or in-use)"
  done
else
  log "  no orphan SSM parameters found"
fi

# SBT ControlPlane の `CognitoAuth` construct が立てる UserPool は default RemovalPolicy.RETAIN
# (= aws-cognito の安全側 default) なので、 `cdk destroy --all` で stack を消しても UserPool が
# 残骸として残る (image #50)。 controlPlaneStack に DestroyPolicySetter を適用すると影響範囲が広い
# (= EventBus / KMS / SystemAdmin Cognito group なども巻き込む) ため、 cleanup.sh で orphan sweep
# する方針。 検出は CFn stack tag (= `aws:cloudformation:stack-name`) を見て、 参照先 stack が
# 既に消えていれば orphan と判定する。
log "scanning for orphan Cognito UserPools (= 元 stack が消えた pool)..."
ORPHAN_POOLS=$(aws cognito-idp list-user-pools --max-results 60 --query "UserPools[].Id" --output text 2>/dev/null || true)
for pool_id in ${ORPHAN_POOLS}; do
  stack_tag=$(aws cognito-idp describe-user-pool --user-pool-id "${pool_id}" \
    --query 'UserPool.UserPoolTags."aws:cloudformation:stack-name"' --output text 2>/dev/null || echo "")
  if [ -z "${stack_tag}" ] || [ "${stack_tag}" = "None" ]; then
    continue
  fi
  # TenkaCloud 由来の stack tag (= tenkacloud-* prefix) のみを対象にする (= 他プロジェクトの pool を
  # 巻き込まない安全策)。
  if [[ "${stack_tag}" != tenkacloud-* ]]; then
    continue
  fi
  if aws cloudformation describe-stacks --stack-name "${stack_tag}" >/dev/null 2>&1; then
    # 元 stack がまだ存在 (= 削除途中 / 残ってる) → スキップ
    continue
  fi
  log "  deleting orphan UserPool ${pool_id} (was in stack ${stack_tag})"
  # delete-user-pool は domain が attach されていると InvalidParameterException で fail する。
  # domain を先に剥がす (= describe-user-pool-domain は domain prefix が分かっている前提だが、
  # describe-user-pool で Domain field を引ける)。
  domain=$(aws cognito-idp describe-user-pool --user-pool-id "${pool_id}" \
    --query 'UserPool.Domain' --output text 2>/dev/null || echo "")
  if [ -n "${domain}" ] && [ "${domain}" != "None" ]; then
    aws cognito-idp delete-user-pool-domain --user-pool-id "${pool_id}" --domain "${domain}" 2>/dev/null \
      || log "    domain ${domain} detach skipped"
  fi
  aws cognito-idp delete-user-pool --user-pool-id "${pool_id}" 2>/dev/null \
    || log "    skip (in-use or already gone)"
done

log "scanning for orphan API Keys (server-Basic / Stand / Premi / Plati or tenkacloud-* tier keys)..."
ORPHAN_KEY_IDS=$(aws apigateway get-api-keys --query \
  "items[?starts_with(name, 'server-Basic-') || starts_with(name, 'server-Stand-') || starts_with(name, 'server-Premi-') || starts_with(name, 'server-Plati-') || contains(name, '-basic-tier-key-') || contains(name, '-standard-tier-key-') || contains(name, '-premium-tier-key-') || contains(name, '-platinum-tier-key-')].id" \
  --output text 2>/dev/null || true)
if [ -n "${ORPHAN_KEY_IDS}" ]; then
  for key_id in ${ORPHAN_KEY_IDS}; do
    log "  deleting orphan api key ${key_id}"
    aws apigateway delete-api-key --api-key "${key_id}" 2>/dev/null \
      || log "    skip (already gone or in-use)"
  done
else
  log "  no orphan api keys found"
fi

log "cleanup complete."
