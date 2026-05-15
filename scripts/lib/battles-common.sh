#!/usr/bin/env bash
# battles-common.sh — deploy-battles.sh / destroy-battles.sh の共通ヘルパー。
#
# 使い方 (sibling script から source する):
#   source "$(dirname "${BASH_SOURCE[0]}")/lib/battles-common.sh"

# stack 名 prefix の規約: `tc-{problemSlug}-{teamSlug}` (template.yaml の AllowedPattern
# `^tc-[a-z0-9]+(-[a-z0-9]+)+$` と一致)。同一 (Account, Region) に複数チームの問題スタックを
# 並べるための衝突回避 prefix。frontend (`apps/application-admin-console/src/lib/resource-naming.ts`)
# と backend (`infrastructure/lib/problem-deploy/handlers/deploy-handler/naming.ts`) でも
# 同じ規約を実装している (cross-language contract)。
build_name_prefix() {
  local problem_dir="$1"
  local team_slug="$2"
  local problem_slug
  problem_slug="$(basename "${problem_dir}")"
  echo "tc-${problem_slug}-${team_slug}"
}

# AWS region を解決。AWS_REGION env か aws cli config から取り、どちらも空ならエラー終了。
resolve_aws_region() {
  local region="${AWS_REGION:-$(aws configure get region 2>/dev/null || echo "")}"
  if [[ -z "${region}" ]]; then
    echo "error: AWS_REGION 未設定。aws configure or 環境変数で指定してください" >&2
    return 1
  fi
  echo "${region}"
}

json_escape() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  value="${value//$'\r'/\\r}"
  value="${value//$'\t'/\\t}"
  printf '%s' "${value}"
}

trace_log() {
  local event="$1"
  shift || true
  local correlation_id="${TENKACLOUD_CORRELATION_ID:-${PROBLEM_EXTERNAL_ID:-}}"
  local job_id="${PROBLEM_EXTERNAL_ID:-${TENKACLOUD_CORRELATION_ID:-}}"
  local json
  json="{\"event\":\"$(json_escape "${event}")\",\"level\":\"info\",\"component\":\"deploy-codebuild\",\"correlationId\":\"$(json_escape "${correlation_id}")\",\"jobId\":\"$(json_escape "${job_id}")\""
  while [[ $# -ge 2 ]]; do
    local key="$1"
    local value="$2"
    shift 2
    if [[ "${key}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
      json="${json},\"${key}\":\"$(json_escape "${value}")\""
    fi
  done
  printf '%s}\n' "${json}"
}

# Phase 2.2 (Issue #459) cross-account AssumeRole helper。
#
# `COMPETITOR_ROLE_ARN` env が空でなければ:
#   1. `EXTERNAL_ID_SSM_PARAMETER` から SSM SecureString で ExternalId を取得
#   2. `aws sts assume-role` に `--external-id` を付けて 15 分の tmp credentials を取得
#   3. AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN を export
#      (= 以降の aws CLI 呼び出しは target account の権限で動く)
#
# 空なら no-op (= same-account deploy 経路を残す。dev / 未 verify 用)。
#
# 副作用: 上記 3 env をシェルに export する。caller の sub-shell scope 内で呼び、
# 別アカウントへ切り替えたあと元に戻す必要があれば `AWS_*` env を退避すること。
#
# Phase 3.2 (Issue #603): rotate 直後の grace fallback を実装。
# 現 ExternalId で AssumeRole が `AccessDenied` 系 error で失敗したら、SSM Parameter Store の
# **1 つ前の version** で 1 度だけ再試行する。これは「rotate UI で更新 → 競技者が CFn stack
# を update しきる」までの数分〜数日の grace を埋める安全網。**N-1 のみ** (= 1 generation
# back) で打ち止め (= 旧 ExternalId で deploy がいつまでも通る状態を作らない)。
#
# 失敗時は非ゼロで return (caller の `set -e` で fail-fast)。
assume_competitor_role_if_configured() {
  local role_arn="${COMPETITOR_ROLE_ARN:-}"
  local ssm_param="${EXTERNAL_ID_SSM_PARAMETER:-}"

  # 両方空 = same-account 経路 (= dev / unconfigured)。
  if [[ -z "${role_arn}" && -z "${ssm_param}" ]]; then
    return 0
  fi

  # 片方だけ空は構成エラー (= 落とす)。
  if [[ -z "${role_arn}" || -z "${ssm_param}" ]]; then
    echo "error: COMPETITOR_ROLE_ARN と EXTERNAL_ID_SSM_PARAMETER は両方必須です (片方のみ設定済)" >&2
    return 1
  fi

  echo "[cross-account] Assuming role: ${role_arn} (ExternalId from SSM: ${ssm_param})"

  # 現 version の値 + version 番号を 1 回の API call で取り出す (= grace fallback 用)。
  local current_json current_external_id current_version
  current_json="$(aws ssm get-parameter --name "${ssm_param}" --with-decryption --output json 2>/dev/null)"
  current_external_id="$(echo "${current_json}" | jq -r '.Parameter.Value // empty')"
  current_version="$(echo "${current_json}" | jq -r '.Parameter.Version // 0')"
  if [[ -z "${current_external_id}" || "${current_external_id}" == "None" ]]; then
    echo "error: ExternalId not found in SSM SecureString: ${ssm_param}" >&2
    return 1
  fi

  if _try_assume_role_with_external_id "${role_arn}" "${current_external_id}"; then
    echo "[cross-account] AssumeRole succeeded (session valid for 900s)."
    _apply_assumed_credentials
    return 0
  fi

  # 現 version で失敗。grace fallback を 1 generation back で 1 回だけ試す。
  local previous_version=$((current_version - 1))
  if [[ "${previous_version}" -le 0 ]]; then
    echo "error: AssumeRole failed with current ExternalId (version=${current_version}) and no previous version is available." >&2
    return 1
  fi

  echo "[cross-account] AssumeRole failed with current ExternalId; trying previous version ${previous_version} (grace fallback)."
  local previous_external_id
  previous_external_id="$(aws ssm get-parameter --name "${ssm_param}:${previous_version}" --with-decryption --query "Parameter.Value" --output text 2>/dev/null || echo "")"
  if [[ -z "${previous_external_id}" || "${previous_external_id}" == "None" ]]; then
    echo "error: AssumeRole failed and previous SSM version ${previous_version} is unavailable (auto-dropped or never existed)." >&2
    return 1
  fi

  if _try_assume_role_with_external_id "${role_arn}" "${previous_external_id}"; then
    # grace fallback の利用は **warning level で必ず log** する (= operator が dashboard /
    # CloudWatch Logs Insights で「rotate 後 grace を使った deploy」を観察できる)。
    echo "[cross-account][WARN] grace_fallback_used: AssumeRole succeeded with previous ExternalId version=${previous_version} (= rotate 直後で競技者 stack 未更新の可能性)。"
    _apply_assumed_credentials
    return 0
  fi

  echo "error: AssumeRole failed with both current and previous (version=${previous_version}) ExternalId. Competitor stack の Update が必要、または rotate が誤って行われた可能性。" >&2
  return 1
}

# Internal helper: 指定 ExternalId で sts:AssumeRole を 1 回試す。
# 成功時: `__ASSUME_ROLE_JSON` シェル変数に response JSON を格納し 0 を返す。
# 失敗時: 非ゼロを返す (= caller が次の version で retry する余地を残す)。
_try_assume_role_with_external_id() {
  local role_arn="$1"
  local external_id="$2"
  local sts_json
  if ! sts_json="$(aws sts assume-role \
    --role-arn "${role_arn}" \
    --role-session-name "tenkacloud-deploy-$(date +%s)" \
    --external-id "${external_id}" \
    --duration-seconds 900 \
    --output json 2>&1)"; then
    return 1
  fi
  __ASSUME_ROLE_JSON="${sts_json}"
  return 0
}

# Internal helper: `__ASSUME_ROLE_JSON` から Credentials を AWS_* env に export する。
_apply_assumed_credentials() {
  AWS_ACCESS_KEY_ID="$(echo "${__ASSUME_ROLE_JSON}" | jq -r '.Credentials.AccessKeyId')"
  AWS_SECRET_ACCESS_KEY="$(echo "${__ASSUME_ROLE_JSON}" | jq -r '.Credentials.SecretAccessKey')"
  AWS_SESSION_TOKEN="$(echo "${__ASSUME_ROLE_JSON}" | jq -r '.Credentials.SessionToken')"
  export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
  # CodeBuild Project が `AWS_DEFAULT_REGION` を inject していないと target account の
  # region 解決が空になる事故があるので、明示的に DEPLOY_REGION (= event detail.region) を反映。
  if [[ -n "${DEPLOY_REGION:-}" ]]; then
    export AWS_REGION="${DEPLOY_REGION}"
    export AWS_DEFAULT_REGION="${DEPLOY_REGION}"
  fi
}
