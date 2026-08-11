#!/usr/bin/env bash
#
# Issue #2948: tenant の machine (M2M) credential を発行 / 一覧 / 失効する。
#
#   issue-machine-client.sh create --user-pool-id <id> --tenant <tenantId> --preset read|deploy|write
#   issue-machine-client.sh list   --user-pool-id <id> --tenant <tenantId>
#   issue-machine-client.sh revoke --user-pool-id <id> --client-id <clientId>
#   issue-machine-client.sh revoke-tenant --user-pool-id <id> --tenant <tenantId>
#
# 設計上の要点:
#
#  - client secret は **1 回だけ stdout に出す**。ファイルにも SSM にも保存しない。
#    tenant 向けの self-service 表示も無い (= `tenantConfig` → SPA 経路に secret を絶対に載せない)。
#  - per-tenant の bind resource server (`tc-tenant-<tenantId>`) は CFn 管理外で、本 script が作る。
#    CFn 管理にすると次の `cdk deploy` が scope list を空へ reconcile して発行済み token を
#    全滅させる。CFn 管理外であることが `revoke-tenant` = deploy 不要の kill switch を成立させる。
#  - Cognito の resource server quota (既定 25 / account / UserPool) を create の前に preflight する。
#
# 注意: `--allowed-o-auth-flows` の enum は underscore の `client_credentials`。hyphen 表記は
# ValidationException になる。

set -euo pipefail

CAPABILITY_RESOURCE_SERVER_ID="tenkacloud"
BIND_RESOURCE_SERVER_PREFIX="tc-tenant-"
BIND_SCOPE_NAME="bind"
MACHINE_CLIENT_NAME_PREFIX="tc-m2m-"
ACCESS_TOKEN_VALIDITY_MINUTES=15
# AWS の既定 quota。Service Quotas で引き上げていれば --quota-limit で上書きする。
DEFAULT_RESOURCE_SERVER_QUOTA=25
# quota の何割を使ったら警告するか (= 20/25)。
QUOTA_WARN_RATIO_NUMERATOR=4
QUOTA_WARN_RATIO_DENOMINATOR=5

usage() {
  sed -n '3,20p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-1}"
}

die() {
  echo "error: $*" >&2
  exit 1
}

require_tool() {
  command -v "$1" >/dev/null 2>&1 || die "$1 が見つかりません (このスクリプトの前提です)"
}

MODE="${1:-}"
[ -n "$MODE" ] || usage 1
shift || true

USER_POOL_ID=""
TENANT_ID=""
PRESET="read"
CLIENT_ID=""
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-}}"
QUOTA_LIMIT="$DEFAULT_RESOURCE_SERVER_QUOTA"

while [ $# -gt 0 ]; do
  case "$1" in
    --user-pool-id) USER_POOL_ID="${2:-}"; shift 2 ;;
    --tenant) TENANT_ID="${2:-}"; shift 2 ;;
    --preset) PRESET="${2:-}"; shift 2 ;;
    --client-id) CLIENT_ID="${2:-}"; shift 2 ;;
    --region) REGION="${2:-}"; shift 2 ;;
    --quota-limit) QUOTA_LIMIT="${2:-}"; shift 2 ;;
    -h|--help) usage 0 ;;
    *) die "不明な引数: $1" ;;
  esac
done

require_tool aws
require_tool jq

[ -n "$USER_POOL_ID" ] || die "--user-pool-id は必須です"
AWS_ARGS=(--user-pool-id "$USER_POOL_ID")
[ -n "$REGION" ] && AWS_ARGS+=(--region "$REGION")

bind_resource_server_id() {
  printf '%s%s' "$BIND_RESOURCE_SERVER_PREFIX" "$1"
}

# tenantId は scope 文字列と Cognito identifier に直接載る。区切り文字や空白が混ざると
# scope の parse が壊れるため、ここで弾く (= handler 側の正規表現と同じ制約)。
validate_tenant_id() {
  case "$1" in
    ""|*/*|*" "*) die "tenantId に空白と '/' は使えません: '$1'" ;;
  esac
}

preflight_resource_server_quota() {
  local count
  count="$(aws cognito-idp list-resource-servers "${AWS_ARGS[@]}" --max-results 50 \
    | jq '.ResourceServers | length')"
  local warn_at=$((QUOTA_LIMIT * QUOTA_WARN_RATIO_NUMERATOR / QUOTA_WARN_RATIO_DENOMINATOR))
  echo "resource servers: ${count}/${QUOTA_LIMIT}" >&2
  if [ "$count" -ge "$QUOTA_LIMIT" ]; then
    die "resource server quota (${QUOTA_LIMIT}) に達しています。既存 tenant の bind resource server を revoke-tenant で回収するか、Service Quotas で上限を引き上げてください"
  fi
  if [ "$count" -ge "$warn_at" ]; then
    echo "warning: resource server 数が quota の ${QUOTA_WARN_RATIO_NUMERATOR}/${QUOTA_WARN_RATIO_DENOMINATOR} を超えました (${count}/${QUOTA_LIMIT})" >&2
  fi
}

ensure_capability_resource_server() {
  aws cognito-idp describe-resource-server "${AWS_ARGS[@]}" \
    --identifier "$CAPABILITY_RESOURCE_SERVER_ID" >/dev/null 2>&1 \
    || die "capability resource server '${CAPABILITY_RESOURCE_SERVER_ID}' がありません。features.machineTokenPath を有効にして tenant stack を deploy してください"
}

ensure_bind_resource_server() {
  local identifier="$1"
  if aws cognito-idp describe-resource-server "${AWS_ARGS[@]}" \
    --identifier "$identifier" >/dev/null 2>&1; then
    echo "bind resource server は既にあります: ${identifier}" >&2
    return 0
  fi
  preflight_resource_server_quota
  aws cognito-idp create-resource-server "${AWS_ARGS[@]}" \
    --identifier "$identifier" \
    --name "$identifier" \
    --scopes "ScopeName=${BIND_SCOPE_NAME},ScopeDescription=TenkaCloud tenant binding" >/dev/null
  echo "bind resource server を作成しました: ${identifier}" >&2
}

resolve_preset_scopes() {
  case "$PRESET" in
    read) printf '%s/ops.read' "$CAPABILITY_RESOURCE_SERVER_ID" ;;
    deploy) printf '%s/ops.read %s/ops.deploy' "$CAPABILITY_RESOURCE_SERVER_ID" "$CAPABILITY_RESOURCE_SERVER_ID" ;;
    # #2955: 失敗した deploy の再投入だけを許す preset。新規 deploy はできない。
    write) printf '%s/ops.read %s/ops.write' "$CAPABILITY_RESOURCE_SERVER_ID" "$CAPABILITY_RESOURCE_SERVER_ID" ;;
    *) die "--preset は read / deploy / write のいずれかです (got: ${PRESET})" ;;
  esac
}

cmd_create() {
  validate_tenant_id "$TENANT_ID"
  ensure_capability_resource_server
  local identifier
  identifier="$(bind_resource_server_id "$TENANT_ID")"
  ensure_bind_resource_server "$identifier"

  local scopes
  # shellcheck disable=SC2207 # 空白区切りの scope 文字列を配列にするのが意図。
  scopes=($(resolve_preset_scopes) "${identifier}/${BIND_SCOPE_NAME}")

  local client_name="${MACHINE_CLIENT_NAME_PREFIX}${TENANT_ID}-${PRESET}"
  local created
  created="$(aws cognito-idp create-user-pool-client "${AWS_ARGS[@]}" \
    --client-name "$client_name" \
    --generate-secret \
    --allowed-o-auth-flows client_credentials \
    --allowed-o-auth-flows-user-pool-client \
    --allowed-o-auth-scopes "${scopes[@]}" \
    --supported-identity-providers COGNITO \
    --access-token-validity "$ACCESS_TOKEN_VALIDITY_MINUTES" \
    --token-validity-units "AccessToken=minutes")"

  local domain
  domain="$(aws cognito-idp describe-user-pool "${AWS_ARGS[@]}" | jq -r '.UserPool.Domain // empty')"

  echo
  echo "=============================================================="
  echo " machine credential (この出力は 1 回きりです。secret は保存されません)"
  echo "=============================================================="
  echo "client name  : ${client_name}"
  echo "client id    : $(echo "$created" | jq -r '.UserPoolClient.ClientId')"
  echo "client secret: $(echo "$created" | jq -r '.UserPoolClient.ClientSecret')"
  echo "scopes       : ${scopes[*]}"
  if [ -n "$domain" ] && [ -n "$REGION" ]; then
    echo "token url    : https://${domain}.auth.${REGION}.amazoncognito.com/oauth2/token"
  else
    echo "token url    : (UserPool の Hosted UI domain と region から組み立ててください)"
  fi
  echo "token ttl    : ${ACCESS_TOKEN_VALIDITY_MINUTES} minutes"
  echo "=============================================================="
  echo "machine API の base URL は tenant stack の CfnOutput 'MachineApiUrl' にあります。"
}

cmd_list() {
  validate_tenant_id "$TENANT_ID"
  # secret は出さない。名前と id と scope だけの inventory。
  aws cognito-idp list-user-pool-clients "${AWS_ARGS[@]}" --max-results 60 \
    | jq -r --arg prefix "${MACHINE_CLIENT_NAME_PREFIX}${TENANT_ID}" \
      '.UserPoolClients[] | select(.ClientName | startswith($prefix)) | [.ClientId, .ClientName] | @tsv' \
    | while IFS=$'\t' read -r client_id client_name; do
        local_scopes="$(aws cognito-idp describe-user-pool-client "${AWS_ARGS[@]}" \
          --client-id "$client_id" | jq -r '.UserPoolClient.AllowedOAuthScopes | join(" ")')"
        printf '%s\t%s\t%s\n' "$client_id" "$client_name" "$local_scopes"
      done
}

cmd_revoke() {
  [ -n "$CLIENT_ID" ] || die "revoke には --client-id が必要です"
  aws cognito-idp delete-user-pool-client "${AWS_ARGS[@]}" --client-id "$CLIENT_ID"
  echo "client を削除しました: ${CLIENT_ID}" >&2
  echo "注意: 発行済み access token は最大 ${ACCESS_TOKEN_VALIDITY_MINUTES} 分間まだ有効です。" >&2
}

# tenant の machine 経路そのものを殺す。bind resource server を消すと、以後 Cognito は
# `tc-tenant-<tenantId>/bind` を発行できなくなり、handler 側の machine 分岐が到達不能になる。
cmd_revoke_tenant() {
  validate_tenant_id "$TENANT_ID"
  local identifier
  identifier="$(bind_resource_server_id "$TENANT_ID")"
  aws cognito-idp list-user-pool-clients "${AWS_ARGS[@]}" --max-results 60 \
    | jq -r --arg prefix "${MACHINE_CLIENT_NAME_PREFIX}${TENANT_ID}" \
      '.UserPoolClients[] | select(.ClientName | startswith($prefix)) | .ClientId' \
    | while read -r client_id; do
        [ -n "$client_id" ] || continue
        aws cognito-idp delete-user-pool-client "${AWS_ARGS[@]}" --client-id "$client_id"
        echo "client を削除しました: ${client_id}" >&2
      done
  if aws cognito-idp describe-resource-server "${AWS_ARGS[@]}" \
    --identifier "$identifier" >/dev/null 2>&1; then
    aws cognito-idp delete-resource-server "${AWS_ARGS[@]}" --identifier "$identifier"
    echo "bind resource server を削除しました: ${identifier}" >&2
  fi
  echo "注意: 発行済み access token は最大 ${ACCESS_TOKEN_VALIDITY_MINUTES} 分間まだ有効です。" >&2
}

case "$MODE" in
  create) cmd_create ;;
  list) cmd_list ;;
  revoke) cmd_revoke ;;
  revoke-tenant) cmd_revoke_tenant ;;
  *) usage 1 ;;
esac
