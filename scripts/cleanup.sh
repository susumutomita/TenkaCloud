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

# `.env` は **source しない**。 理由は 2 段構えで、 片方だけ潰しても再発する。
#
#   1. bash の代入は `KEY={"a":true}` を囲む double quote を剥がす。 実測:
#        make が export した値 -> {"samlSso":true}
#        bash で source した値 -> {samlSso:true}
#   2. Makefile は `-include $(ENV_FILE)` の直後に裸の `export` を置いている (= 全 make
#      変数を export)。 つまり `.env` 由来の変数は **既に環境に入った状態** で本スクリプト
#      に渡る。 export 済みの変数へ代入し直すと export 属性は維持されるので、 `set -a` を
#      外しただけでは 1. の化けた値がそのまま子プロセスへ伝播する。
#
# 化けた `CDK_PARAM_FEATURES` を受け取った cdk 側は、 dotenv loader が「既に環境に在る」
# と見なして上書きせず (= `injected env (0)`)、 resolveAppConfig が JSON parse で落ちて
# synth ごと死ぬ。 その結果 `cdk destroy --all` は stack を 1 つも消せない。
#
# よって `.env` を丸ごと読み込まず、 このスクリプト自身が要る key だけを直接引く。 CDK app
# は自分で同じ `.env` を読むので中継は不要で、 make 経由なら make が正しい値を渡してくる。
read_env_value() {
  local key="$1" value
  [[ -f "${ENV_FILE}" ]] || return 0
  value=$(sed -n "s/^[[:space:]]*${key}=//p" "${ENV_FILE}" | tail -1)
  # 値全体を囲む quote だけ剥がす (dotenv と同じ扱い)。 中身の quote は保つ。
  if ((${#value} >= 2)); then
    case "${value}" in
      \"*\" | \'*\') value="${value:1:${#value}-2}" ;;
    esac
  fi
  printf '%s' "${value}"
}

SYSTEM_ADMIN_EMAIL="${SYSTEM_ADMIN_EMAIL:-$(read_env_value SYSTEM_ADMIN_EMAIL)}"
if [[ -z "${SYSTEM_ADMIN_EMAIL}" ]]; then
  echo "ERROR: SYSTEM_ADMIN_EMAIL is not set (check ${ENV_FILE})" >&2
  exit 1
fi

# aws CLI の宛先は従来どおり `.env` に従わせる (環境に無いときだけ `.env` で補う)。
for aws_var in AWS_PROFILE AWS_REGION AWS_DEFAULT_REGION; do
  if [[ -z "${!aws_var:-}" ]]; then
    aws_value="$(read_env_value "${aws_var}")"
    if [[ -n "${aws_value}" ]]; then
      export "${aws_var}=${aws_value}"
    fi
  fi
done

# `export VAR="$(cmd)"` は export の終了ステータスが勝つため cmd の失敗を握り潰す (SC2155)。
# 実害: AWS session が切れていても ACCOUNT_ID="" のまま先へ進み、 空 account id から
# 組み立てた bucket 名で sweep を続けてしまう。 assign と export を分け、 空なら即止める。
REGION="$(aws configure get region || true)"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text 2>/dev/null || true)"
if [[ -z "${REGION}" || -z "${ACCOUNT_ID}" ]]; then
  echo "ERROR: AWS の region / account を解決できません (region='${REGION}' account='${ACCOUNT_ID}')。" >&2
  echo "       認証が切れている可能性があります。 aws login で再認証してから再実行してください。" >&2
  exit 1
fi
export REGION ACCOUNT_ID
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
# Issue #2960: 旧実装はこのループの要素が 1 件 (`/aws/vendedlogs/states/StepFunctionLogging`)
# しか無く、 実測で残っていた 48 個はどれも一致しないので素通りしていた。 同 file の SSM
# parameter 掃除は prefix 走査で正しく書けているので、 log group だけ実装が取り残されていた。
#
# `/aws/lambda/*` は **CFn の所有物ではない**。 Lambda 関数の log group は初回実行時に Lambda
# サービスが暗黙に作るので、 stack を消しても消えない。 掃除する主体がどこにも居ないのが問題
# なので、 ここで拾う。
#
# 対象 prefix は次の 3 系統。 いずれも `tenkacloud` を含む名前だけを消し、 含まないものには
# 触らない (`/aws/apigateway/welcome` のようなアカウント共通のものを巻き込まない)。
LOG_GROUP_PREFIXES=(
  "/aws/lambda/tenkacloud"
  "tenkacloud-"
  "/aws/codebuild/provisioningJobRunner"
  "/aws/codebuild/deprovisioningJobRunner"
  "/aws/codebuild/CdkCodeBuildProject"
)
log "scanning for orphan LogGroups (${#LOG_GROUP_PREFIXES[@]} prefixes)..."
DELETED_LOG_GROUP_COUNT=0
for lg_prefix in "${LOG_GROUP_PREFIXES[@]}"; do
  orphan_names=$(aws logs describe-log-groups --log-group-name-prefix "${lg_prefix}" \
    --query 'logGroups[].logGroupName' --output text 2>/dev/null || true)
  for lg_name in ${orphan_names}; do
    # SBT の CodeBuild 系は名前に tenkacloud を含まないことがあるので、 prefix 一致で拾った
    # ものはそのまま対象にする。 ただし prefix が `tenkacloud` 系でない場合に限り、 他人の
    # log group を巻き込まないよう名前側の確認をもう一段入れる。
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
    log "  deleting orphan log group ${lg_name}"
    if aws logs delete-log-group --log-group-name "${lg_name}" >/dev/null 2>&1; then
      DELETED_LOG_GROUP_COUNT=$((DELETED_LOG_GROUP_COUNT + 1))
    else
      # `--output text` は tab 区切りの 1 行で返るので、 名前単位に割ってから完全一致で見る
      # (部分一致だと似た名前の log group を 「まだ居る」 と誤判定する)。
      if aws logs describe-log-groups --log-group-name-prefix "${lg_name}" \
        --query 'logGroups[].logGroupName' --output text 2>/dev/null \
        | tr '\t' '\n' | grep -qx "${lg_name}"; then
        log "    FAILED to delete ${lg_name}"
        CLEANUP_FAILURES+=("logs delete-log-group ${lg_name}")
      else
        log "    already gone"
      fi
    fi
  done
done
log "  deleted ${DELETED_LOG_GROUP_COUNT} orphaned log group(s)"

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

# Issue #2444 → #2959: かつては「列挙して billing 警告を出すだけ」だった。 その運用の実測結果が
# 「8 table + GSI 7 本 = 15 ユニット組を 3 か月弱払い続けていた」なので、 既定を削除に変えた。
#
# #2959 で RemovalPolicy 自体も既定 DESTROY になったが、 それは **これから deploy し直す stack**
# にしか効かない。 過去に RETAIN で deploy されて既に stack が消えている table は、 パラメータを
# 足しても孤児のまま残る。 この sweep はその積み残しを回収する唯一の経路になる。
#
# 対象は `tenkacloud` prefix を持つ table だけ (scripts/lib/retained-tables.ts と同じ規則)。
# 他プロジェクトの table を巻き込まないことが最優先で、 迷ったら消さない。
log "scanning for orphaned DynamoDB tables (tenkacloud prefix)..."
ORPHAN_TABLES=$(aws dynamodb list-tables --query 'TableNames[]' --output text 2>/dev/null || true)
DELETED_TABLE_COUNT=0
if [ -n "${ORPHAN_TABLES}" ]; then
  for table_name in ${ORPHAN_TABLES}; do
    # prefix 一致しないものは他プロジェクトの table。 触らない。
    case "$(printf '%s' "${table_name}" | tr '[:upper:]' '[:lower:]')" in
      tenkacloud*) ;;
      *) continue ;;
    esac
    log "  deleting orphan DynamoDB table ${table_name}"
    if aws dynamodb delete-table --table-name "${table_name}" >/dev/null 2>&1; then
      DELETED_TABLE_COUNT=$((DELETED_TABLE_COUNT + 1))
    else
      # 既に消えている / 削除中は成功扱いにする (冪等)。 それ以外は握り潰さず collect する。
      if aws dynamodb describe-table --table-name "${table_name}" >/dev/null 2>&1; then
        log "    FAILED to delete ${table_name}"
        CLEANUP_FAILURES+=("dynamodb delete-table ${table_name}")
      else
        log "    already gone"
      fi
    fi
  done
fi
log "  deleted ${DELETED_TABLE_COUNT} orphaned DynamoDB table(s)"

if ((${#CLEANUP_FAILURES[@]} > 0)); then
  log "cleanup INCOMPLETE -- the following steps failed:"
  for failure in "${CLEANUP_FAILURES[@]}"; do
    log "  - ${failure}"
  done
  log "AWS resources are still deployed. Fix the errors above and re-run make destroy-saas."
  exit 1
fi

log "cleanup complete."
