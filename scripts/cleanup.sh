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

# 失敗した step を貯めて最後にまとめて非 0 で落ちる。 個々の step は idempotent なので
# 1 つ失敗しても残りは走らせる価値があるが、 「1 つも消えていないのに exit 0 + cleanup
# complete.」で終わるのは偽の成功であり、 実際に teardown が丸ごと no-op になったまま
# 気付けなかった事故がある (= cdk destroy --all の失敗が log 1 行に握り潰されていた)。
CLEANUP_FAILURES=()

# stack の削除完了を待つ。 `aws cloudformation wait stack-delete-complete` は使わない:
# CFn は「export が他 stack に import 済み」等の理由で delete を受理した直後にキャンセルし、
# stack を元の status (= CREATE_COMPLETE 等) に戻すことがある。 wait はこの復帰 status を
# 終端と見なさず 30s x 120 = 最大 60 分ポーリングし続けるため、 teardown が固まったように
# 見えるだけで何も進まない。 DELETE_IN_PROGRESS を抜けた時点で打ち切り、 CFn が返した理由を
# そのまま surface する。 待ち時間の総量は従来 (= 60 分) を維持する。
wait_stack_deleted() {
  local stack_name="$1"
  local attempts=240
  local interval=15
  local status reason attempt
  for ((attempt = 0; attempt < attempts; attempt++)); do
    # 消えた stack は describe-stacks が ValidationError で落ちる (= 削除完了)。
    if ! status=$(aws cloudformation describe-stacks --stack-name "${stack_name}" \
      --query 'Stacks[0].StackStatus' --output text 2>/dev/null); then
      return 0
    fi
    case "${status}" in
      DELETE_COMPLETE)
        return 0
        ;;
      DELETE_IN_PROGRESS)
        sleep "${interval}"
        ;;
      *)
        log "  ${stack_name} delete did not proceed (status=${status})"
        reason=$(aws cloudformation describe-stack-events --stack-name "${stack_name}" \
          --max-items 5 \
          --query "StackEvents[?ResourceStatusReason != null].ResourceStatusReason | [0]" \
          --output text 2>/dev/null || true)
        if [[ -n "${reason}" && "${reason}" != "None" ]]; then
          log "    CFn: ${reason}"
        fi
        return 1
        ;;
    esac
  done
  log "  ${stack_name} still DELETE_IN_PROGRESS after $((attempts * interval))s"
  return 1
}

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

# `.env` は **export せずに** 読む (= `set -a` を使わない)。
#
# bash の `source` は `KEY={"a":true}` の double quote を剥がすため、 JSON 値を持つ
# CDK_PARAM_* (実在: `CDK_PARAM_FEATURES={"samlSso":true}`) が `{a:true}` に化ける。
# `set -a` でこれを export すると、 bin/infrastructure.ts 側の dotenv loader は
# 「既に環境に在る」と見なして上書きせず (= `injected env (0)`)、 resolveAppConfig の
# JSON parse が落ちて synth ごと死ぬ。 結果 `cdk destroy --all` は stack を 1 つも
# 消せないまま失敗する。
#
# CDK app は自分で同じ `.env` を読むので、 ここから中継する必要はない。 このスクリプト
# 自身が要るのは SYSTEM_ADMIN_EMAIL だけ。 ただし aws CLI の宛先 (profile / region) は
# 従来どおり `.env` に従わせたいので、 その 3 つだけ明示的に export する。
if [[ -f "${ENV_FILE}" ]]; then
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  for aws_var in AWS_PROFILE AWS_REGION AWS_DEFAULT_REGION; do
    if [[ -n "${!aws_var:-}" ]]; then
      export "${aws_var?}"
    fi
  done
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
  if ! CDK_PARAM_TENANT_ID="$tenant_id" bun run cdk -- destroy "$stack_name" --force; then
    log "    ERROR: ${stack_name} destroy failed"
    CLEANUP_FAILURES+=("${stack_name} destroy")
  fi
done

log "cdk destroy --all (backend stacks)..."
if ! bun run cdk -- destroy --all --force; then
  log "  ERROR: cdk destroy --all failed -- backend stacks are STILL DEPLOYED"
  CLEANUP_FAILURES+=("cdk destroy --all")
fi

# admin-console-hosting は CDK app 内の stack なので通常は上の `cdk destroy --all` で消える。
# ここはその経路が使えなかった場合 (= synth 不能 / CDK app 外に取り残された等) の fallback
# として CFN 直 delete を試す。
#
# 実行位置が `cdk destroy --all` の **後** なのは意図的。 本 stack の CloudFront
# distributionDomainName は control-plane / admin-console-insight が cross-stack ref で
# import しており、 それらより先に消そうとすると CFn が
#   Cannot delete export ... as it is in use by tenkacloud-admin-console-insight and ...
# で delete を即キャンセルする (= 先に置くとフル deploy 状態では必ず失敗する)。
if aws cloudformation describe-stacks --stack-name tenkacloud-admin-console-hosting >/dev/null 2>&1; then
  log "deleting leftover tenkacloud-admin-console-hosting via CloudFormation..."
  aws cloudformation delete-stack --stack-name tenkacloud-admin-console-hosting
  if ! wait_stack_deleted tenkacloud-admin-console-hosting; then
    CLEANUP_FAILURES+=("tenkacloud-admin-console-hosting delete")
  fi
else
  log "tenkacloud-admin-console-hosting not found; skip"
fi

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

# Issue #2444: 全 DynamoDB テーブルは RemovalPolicy.RETAIN (履歴保全のため意図的) なので、
# ここまでの destroy 後もテーブルは残り、 PROVISIONED 1/1 の standing cost を出し続ける。
# 残存テーブルを列挙して billing 警告を出す (削除はしない — 誤削除防止)。 report スクリプトは
# 常に exit 0 だが、 万一 bun 不在等で失敗しても cleanup の冪等性 / exit code は壊さない。
log "checking for RETAIN-orphaned DynamoDB tables (billing warning only)..."
bun run "${TenkaCloud_ROOT}/scripts/ops/report-retained-tables.ts" \
  || log "  retained-table check skipped (non-fatal)"

if ((${#CLEANUP_FAILURES[@]} > 0)); then
  log "cleanup INCOMPLETE -- the following steps failed:"
  for failure in "${CLEANUP_FAILURES[@]}"; do
    log "  - ${failure}"
  done
  log "AWS resources are still deployed. Fix the errors above and re-run make destroy-saas."
  exit 1
fi

log "cleanup complete."
