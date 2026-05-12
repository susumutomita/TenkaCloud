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

  local external_id
  external_id="$(aws ssm get-parameter --name "${ssm_param}" --with-decryption --query "Parameter.Value" --output text)"
  if [[ -z "${external_id}" || "${external_id}" == "None" ]]; then
    echo "error: ExternalId not found in SSM SecureString: ${ssm_param}" >&2
    return 1
  fi

  # 15 分は AWS STS の minimum session duration。短くするほど token 漏洩リスクが小さい。
  local sts_json
  sts_json="$(aws sts assume-role \
    --role-arn "${role_arn}" \
    --role-session-name "tenkacloud-deploy-$(date +%s)" \
    --external-id "${external_id}" \
    --duration-seconds 900)"

  AWS_ACCESS_KEY_ID="$(echo "${sts_json}" | jq -r '.Credentials.AccessKeyId')"
  AWS_SECRET_ACCESS_KEY="$(echo "${sts_json}" | jq -r '.Credentials.SecretAccessKey')"
  AWS_SESSION_TOKEN="$(echo "${sts_json}" | jq -r '.Credentials.SessionToken')"
  export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
  # CodeBuild Project が `AWS_DEFAULT_REGION` を inject していないと target account の
  # region 解決が空になる事故があるので、明示的に DEPLOY_REGION (= event detail.region) を反映。
  if [[ -n "${DEPLOY_REGION:-}" ]]; then
    export AWS_REGION="${DEPLOY_REGION}"
    export AWS_DEFAULT_REGION="${DEPLOY_REGION}"
  fi
  echo "[cross-account] AssumeRole succeeded (session valid for 900s)."
}
