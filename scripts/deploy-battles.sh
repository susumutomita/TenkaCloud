#!/usr/bin/env bash
# deploy-battles.sh — 引数に問題ディレクトリを受け取り、順次 CFn deploy する smoke test ツール。
#
# Usage:
#   bash scripts/deploy-battles.sh <problem-dir> [<problem-dir> ...]
#
# 環境変数:
#   TEAM_SLUG     チーム識別子。リソース名 prefix `tc-{problemSlug}-{teamSlug}` に使う。
#                 default: "demo-team"
#   AWS_REGION    deploy 先 region。default: aws cli config から取得
#   DB_PASSWORD   問題テンプレ (security-battle-royale 等) の DbPassword Parameter に渡す。
#                 未指定なら deploy ごとにランダム生成 (32 桁英数字)。secret を repo に残さない
#                 ため、固定値が必要なときは呼び出し側で `DB_PASSWORD=xxx make deploy-battles` を使う
#
# 例:
#   bash scripts/deploy-battles.sh problems/challenges/hello-world
#   bash scripts/deploy-battles.sh problems/challenges/hello-world problems/battles/security-battle-royale
#   TEAM_SLUG=alpha bash scripts/deploy-battles.sh problems/challenges/hello-world
#
# CFn template の Parameter は metadata.json の `cfnParameters` で宣言する (= 問題作者が
# 必要な値を渡す)。`NamePrefix` だけは script が自動注入する。`__RANDOM_PASSWORD__` を
# value に置くと deploy ごとにランダム生成 (DbPassword 等の secret 用途)。
#
# 設計意図:
#   SaaS 配線 (Step Functions / EventBridge / tenant API / Cognito) を一切持ち込まず、
#   選択した問題の CFn template と AWS 権限の正しさだけを smoke test する。
#   この script 自身は tenant onboarding や event 単位の orchestration を行わない。

set -euo pipefail

# shellcheck source=lib/battles-common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/battles-common.sh"

# CFn template の Description などに含まれる multibyte 文字 (日本語等) が aws CLI 経由で
# 「?」に化ける現象がある。LC_ALL/LANG が C / POSIX / 空 のとき、aws CLI 内部の Python が
# template file を ASCII codec で open し、UTF-8 chars を replace してしまうため。
# 値が ASCII-only locale なら UTF-8 に倒す。
case "${LC_ALL:-${LANG:-}}" in
  C|POSIX|"")
    export LANG="en_US.UTF-8"
    export LC_ALL="en_US.UTF-8"
    ;;
esac

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <problem-dir> [<problem-dir> ...]" >&2
  echo "  e.g.: $0 problems/challenges/hello-world" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "error: jq が必要です (brew install jq / apt install jq)" >&2
  exit 1
fi

TEAM_SLUG="${TEAM_SLUG:-demo-team}"
TENKACLOUD_ACCOUNT_ID="${TENKACLOUD_ACCOUNT_ID:-}"
if [[ -z "${TENKACLOUD_ACCOUNT_ID}" ]]; then
  TENKACLOUD_ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
fi
if [[ ! "${TENKACLOUD_ACCOUNT_ID}" =~ ^[0-9]{12}$ ]]; then
  echo "error: TENKACLOUD_ACCOUNT_ID must be a 12-digit AWS account ID" >&2
  exit 1
fi
export TENKACLOUD_ACCOUNT_ID

# Phase 2.2 (Issue #459): COMPETITOR_ROLE_ARN が set されているなら、aws CLI 呼び出し前に
# AssumeRole + ExternalId で tmp credentials に切り替える。空なら same-account 経路で動く。
assume_competitor_role_if_configured

AWS_REGION="$(resolve_aws_region)"
trace_log "deploy.codebuild.start" operation "create" region "${AWS_REGION}" teamSlug "${TEAM_SLUG}" problemCount "$#"

# metadata.json の cfnParameters を `Key=Value` 形式の配列に展開する。`__RANDOM_PASSWORD__`
# トークンは 32 桁ランダム英数字に置換 (DbPassword 等の secret 用途)。`NamePrefix` は
# script が常に自動注入するので、ここでは扱わない。
build_parameter_overrides() {
  local problem_dir="$1"
  local name_prefix="$2"
  local metadata="${problem_dir}/metadata.json"
  local problem_external_id="${PROBLEM_EXTERNAL_ID:-}"
  if [[ -z "${problem_external_id}" ]]; then
    problem_external_id="$(set +o pipefail; LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 32)"
  fi
  if [[ ${#problem_external_id} -lt 16 ]]; then
    echo "error: PROBLEM_EXTERNAL_ID must be at least 16 characters" >&2
    return 1
  fi

  local -a overrides=(
    "NamePrefix=${name_prefix}"
    "TenkaCloudAccountId=${TENKACLOUD_ACCOUNT_ID}"
    "ExternalId=${problem_external_id}"
  )

  if [[ ! -f "${metadata}" ]]; then
    printf '%s\n' "${overrides[@]}"
    return 0
  fi

  local key value
  while IFS=$'\t' read -r key value; do
    [[ -z "${key}" ]] && continue
    if [[ "${value}" == "__RANDOM_PASSWORD__" ]]; then
      # /dev/urandom を `tr` で英数字に絞って 32 桁切り出す。`head -c 32` が早期 close した
      # 際の SIGPIPE で `set -o pipefail` が pipeline を 141 で fail させることがあるため、
      # subshell で pipefail を局所的に無効化する。
      value="$(set +o pipefail; LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 32)"
    fi
    overrides+=("${key}=${value}")
  done < <(jq -r '.cfnParameters // {} | to_entries[] | "\(.key)\t\(.value)"' "${metadata}")

  printf '%s\n' "${overrides[@]}"
}

#
# Issue #634: private 問題の payload を S3 から取得する。
#
# 環境変数 `CHALLENGE_PAYLOAD_URL` が set されているとき、 problem_dir を local path として
# 信頼せず、 presigned URL から zip を取得し /tmp に展開してそちらを problem_dir に差し替える。
# Phase 2 (CDK ChallengePayloadStack) が deploy された後、 deploy-handler Lambda が
# Step Functions に env override で URL を渡す。 URL は 15min TTL の presigned。
#
# Phase 2 未 deploy 時は CHALLENGE_PAYLOAD_URL は常に空文字 → 既存 local-path 経路で動く
# (= 既存 public 問題への影響なし)。
resolve_problem_dir() {
  local input_dir="$1"
  if [[ -z "${CHALLENGE_PAYLOAD_URL:-}" ]]; then
    # public 問題: 引数の dir をそのまま使う (= 既存挙動)
    echo "${input_dir}"
    return 0
  fi

  # private 問題: presigned URL から zip を download → 展開
  if ! command -v unzip >/dev/null 2>&1; then
    echo "error: unzip が必要です (CHALLENGE_PAYLOAD_URL からの展開で使う)" >&2
    return 1
  fi
  local payload_dir
  payload_dir="$(mktemp -d -t challenge-payload-XXXXXX)"
  echo "Downloading private challenge payload to ${payload_dir}..." >&2
  if ! curl -sSfL --max-time 60 -o "${payload_dir}/payload.zip" "${CHALLENGE_PAYLOAD_URL}"; then
    echo "error: presigned URL からの payload download に失敗しました (= URL 期限切れ or network)" >&2
    return 1
  fi
  unzip -q "${payload_dir}/payload.zip" -d "${payload_dir}"
  # zip 内には 1 dir = problem dir の構造を想定 (= problems/<category>/<id>/ をそのまま zip)
  local extracted_dir
  extracted_dir="$(find "${payload_dir}" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
  if [[ -z "${extracted_dir}" || ! -f "${extracted_dir}/template.yaml" ]]; then
    echo "error: zip 内に template.yaml を含む dir が見つかりません (= zip 構造不正)" >&2
    return 1
  fi
  echo "${extracted_dir}"
}

deploy_one() {
  local problem_dir="$1"
  # private 問題は zip を展開して dir を差し替え、public 問題は local dir をそのまま使う。
  problem_dir="$(resolve_problem_dir "${problem_dir}")"
  local template="${problem_dir}/template.yaml"
  if [[ ! -f "${template}" ]]; then
    echo "error: ${template} が見つかりません" >&2
    return 1
  fi

  local problem_slug
  problem_slug="$(basename "${problem_dir}")"
  local name_prefix
  name_prefix="$(build_name_prefix "${problem_dir}" "${TEAM_SLUG}")"

  # macOS 標準 bash 3.2 は `mapfile` (bash 4+) 未対応なので、while read で配列を埋める。
  local -a parameter_overrides=()
  local line
  while IFS= read -r line; do
    parameter_overrides+=("${line}")
  done < <(build_parameter_overrides "${problem_dir}" "${name_prefix}")

  echo ""
  echo "=========================================="
  echo "Deploying: ${problem_dir}"
  echo "  StackName : ${name_prefix}"
  echo "  Region    : ${AWS_REGION}"
  echo "  TeamSlug  : ${TEAM_SLUG}"
  echo "  Parameters: ${#parameter_overrides[@]} item(s) (NamePrefix + TenkaCloudAccountId + ExternalId + cfnParameters)"
  echo "=========================================="
  trace_log "deploy.cfn.deploy.start" stackName "${name_prefix}" region "${AWS_REGION}" teamSlug "${TEAM_SLUG}" problemDir "${problem_dir}"

  # A previous attempt that failed during CREATE leaves the stack in
  # ROLLBACK_COMPLETE / CREATE_FAILED, which `aws cloudformation deploy` cannot
  # update — the retry would abort before issuing any CFn operation. Delete the
  # un-updatable stack first so this run re-creates it cleanly.
  delete_unrecoverable_stack_if_present "${name_prefix}" "${AWS_REGION}"

  # `aws cloudformation deploy` は CreateStack / UpdateStack を冪等に扱う:
  #   - stack が無ければ Create
  #   - stack があれば Update (差分が無ければ "No changes" で 0 終了)
  #   - --no-fail-on-empty-changeset で「差分無し」を成功扱いにする (rerun 時の運用上の都合)
  #
  # Issue #895: stack カタログ用 tag を打つ。 operator が
  # `cloudformation:ListStacks` / Resource Groups Tagging API で次の用途で逆引きできる:
  #   - TenantId    : tenant 別の deploy 一覧
  #   - JobId       : 1 deploy = 1 job、 retry / drill-down の identity
  #   - BatchId     : bulk 発火 (= 同一 event の N×M 個 deploy) のグルーピング、
  #                   未指定なら JobId と同値 fallback (= 単発 / authoring iteration)
  # 既存 NamePrefix / Problem / TeamSlug / DeployedBy tag は維持する (旧 operator UI 互換)。
  TENKACLOUD_TENANT_ID="${TENKACLOUD_TENANT_ID:-unknown}"
  TENKACLOUD_JOB_ID="${TENKACLOUD_JOB_ID:-${TENKACLOUD_CORRELATION_ID:-unknown}}"
  TENKACLOUD_BATCH_ID="${TENKACLOUD_BATCH_ID:-${TENKACLOUD_JOB_ID}}"
  # #1381: same-account 経路では CFn 専用 service role (CFN_EXEC_ROLE_ARN) を CFn に渡す。
  # CodeBuild role 自体からは iam:*/ec2:* を剥がしたので、 リソース作成は CFn がこの role を
  # assume して行う。 cross-account 経路 (COMPETITOR_ROLE_ARN set) では assumed competitor role
  # の権限で動くため --role-arn は付けない。
  local -a cfn_deploy_role_args=()
  if [[ -z "${COMPETITOR_ROLE_ARN:-}" && -n "${CFN_EXEC_ROLE_ARN:-}" ]]; then
    cfn_deploy_role_args=(--role-arn "${CFN_EXEC_ROLE_ARN}")
  fi
  if ! aws cloudformation deploy \
    --region "${AWS_REGION}" \
    --stack-name "${name_prefix}" \
    --template-file "${template}" \
    --capabilities CAPABILITY_NAMED_IAM \
    --no-fail-on-empty-changeset \
    ${cfn_deploy_role_args[@]+"${cfn_deploy_role_args[@]}"} \
    --parameter-overrides "${parameter_overrides[@]}" \
    --tags \
      "TenkaCloud:NamePrefix=${name_prefix}" \
      "TenkaCloud:Problem=${problem_slug}" \
      "TenkaCloud:ProblemId=${problem_slug}" \
      "TenkaCloud:TeamSlug=${TEAM_SLUG}" \
      "TenkaCloud:TenantId=${TENKACLOUD_TENANT_ID}" \
      "TenkaCloud:JobId=${TENKACLOUD_JOB_ID}" \
      "TenkaCloud:BatchId=${TENKACLOUD_BATCH_ID}" \
      "TenkaCloud:DeployedBy=deploy-battles.sh"; then
    trace_log "deploy.cfn.deploy.failed" stackName "${name_prefix}" region "${AWS_REGION}" teamSlug "${TEAM_SLUG}" problemDir "${problem_dir}"
    echo "error: CloudFormation deploy failed for ${name_prefix}" >&2
    return 1
  fi
  trace_log "deploy.cfn.deploy.succeeded" stackName "${name_prefix}" region "${AWS_REGION}" teamSlug "${TEAM_SLUG}" problemDir "${problem_dir}"

  # outputs を表示 (FrontendUrl 等が見える)
  echo ""
  echo "Outputs for ${name_prefix}:"
  aws cloudformation describe-stacks \
    --region "${AWS_REGION}" \
    --stack-name "${name_prefix}" \
    --query "Stacks[0].Outputs" \
    --output table
}

failures=()
for problem_dir in "$@"; do
  # 末尾のスラッシュを正規化
  problem_dir="${problem_dir%/}"
  if ! deploy_one "${problem_dir}"; then
    failures+=("${problem_dir}")
  fi
done

echo ""
echo "=========================================="
if [[ ${#failures[@]} -eq 0 ]]; then
  trace_log "deploy.codebuild.succeeded" operation "create" region "${AWS_REGION}" problemCount "$#"
  echo "All $# deploy(s) succeeded."
  exit 0
else
  trace_log "deploy.codebuild.failed" operation "create" region "${AWS_REGION}" failureCount "${#failures[@]}" problemCount "$#"
  echo "Failed deploys (${#failures[@]} of $#):"
  for f in "${failures[@]}"; do
    echo "  - ${f}"
  done
  exit 1
fi
