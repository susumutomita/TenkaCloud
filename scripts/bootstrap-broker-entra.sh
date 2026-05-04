#!/bin/bash
set -eo pipefail

# Microsoft Entra ID テナントに「broker」 App registration を作成して
# Graph API admin-consent + client secret 生成 + SSM SecureString への保存まで
# 一気通貫で行う対話型ブートストラップ。
#
# 一度動かせば broker が用意できるので、以後 `make deploy` は credentials を
# 自分で書かずに動く。
#
# Usage:
#   make bootstrap-broker-entra
#   # または
#   bash scripts/bootstrap-broker-entra.sh
#
# 前提:
#   - Azure CLI (`az`) インストール済み
#   - AWS CLI ログイン済み (SSM put-parameter 用)
#   - 実行ユーザーが Entra ID テナントの Global Administrator または Privileged Role
#     Administrator (admin-consent を grant するため)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/broker-entra-env.sh
source "${SCRIPT_DIR}/lib/broker-entra-env.sh"
TenkaCloud_load_broker_entra_env

# Microsoft Graph application-permission の well-known UUID
GRAPH_RESOURCE_APP_ID="00000003-0000-0000-c000-000000000000"
PERM_APPLICATION_READWRITE_ALL="1bfefb4e-e0b5-418b-a88f-73c46d2cc8e9"
PERM_USER_INVITE_ALL="09850681-111b-4a89-9bed-3f2cae46d706"
PERM_APPROLE_ASSIGNMENT_READWRITE_ALL="06b708a9-e830-4db3-a914-8e69da51d44f"

DISPLAY_NAME="TenkaCloud Broker (${BROKER_ENTRA_PROFILE_ID})"

bold()   { printf "\033[1m%s\033[0m\n" "$*"; }
green()  { printf "\033[32m%s\033[0m\n" "$*"; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }
die()    { printf "\033[31mERROR:\033[0m %s\n" "$*" >&2; exit 1; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "$1 が見つかりません ($2)"
}

require_cmd az "Azure CLI を https://learn.microsoft.com/cli/azure/install-azure-cli からインストールしてください"
require_cmd aws "AWS CLI が必要です"
require_cmd jq "jq が必要です"

bold "==> Bootstrap broker Entra App registration"
echo "  Profile ID    : ${BROKER_ENTRA_PROFILE_ID}"
echo "  SSM parameter : ${BROKER_ENTRA_GRAPH_PARAMETER_NAME}"
echo "  Display name  : ${DISPLAY_NAME}"
echo ""

# 既に SSM に同じ profile の credential がある場合は確認
if aws ssm get-parameter --name "${BROKER_ENTRA_GRAPH_PARAMETER_NAME}" --with-decryption >/dev/null 2>&1; then
  yellow "SSM parameter '${BROKER_ENTRA_GRAPH_PARAMETER_NAME}' は既に存在します。"
  read -r -p "  既存値を上書きして再 bootstrap しますか? [y/N]: " confirm
  if [[ ! "${confirm,,}" =~ ^y(es)?$ ]]; then
    echo "中断しました。"
    exit 0
  fi
fi

# 1. az login (device code flow)
bold "==> Step 1/6: Azure へログイン (device code flow)"
echo "  ブラウザが開かない場合は表示される URL とコードを使ってください。"
echo "  Global Admin 権限を持つアカウントで sign-in が必要です。"
# --allow-no-subscriptions: Entra-only テナント (Azure subscription 無し) で az login が
# 'No subscriptions found' で落ちないようにする。本 script は subscription を必要としない
# (Graph API しか叩かない) ので unconditionally に付ける。
az login --use-device-code --allow-no-subscriptions --output none

TENANT_ID=$(az account show --query tenantId -o tsv)
ACCOUNT_UPN=$(az account show --query user.name -o tsv)
echo "  Tenant ID : ${TENANT_ID}"
echo "  Sign-in   : ${ACCOUNT_UPN}"

# 2. App registration: 既存があれば再利用
bold "==> Step 2/6: App registration"
EXISTING_APP_ID=$(az ad app list --display-name "${DISPLAY_NAME}" --query "[0].appId" -o tsv 2>/dev/null || true)
if [[ -n "${EXISTING_APP_ID}" ]]; then
  APP_ID="${EXISTING_APP_ID}"
  green "  既存 app を再利用: appId=${APP_ID}"
else
  REQUIRED_RESOURCE_ACCESSES=$(jq -cn \
    --arg graph "${GRAPH_RESOURCE_APP_ID}" \
    --arg p1 "${PERM_APPLICATION_READWRITE_ALL}" \
    --arg p2 "${PERM_USER_INVITE_ALL}" \
    --arg p3 "${PERM_APPROLE_ASSIGNMENT_READWRITE_ALL}" \
    '[{
       resourceAppId: $graph,
       resourceAccess: [
         {id: $p1, type: "Role"},
         {id: $p2, type: "Role"},
         {id: $p3, type: "Role"}
       ]
     }]')
  APP_ID=$(az ad app create \
    --display-name "${DISPLAY_NAME}" \
    --sign-in-audience AzureADMyOrg \
    --required-resource-accesses "${REQUIRED_RESOURCE_ACCESSES}" \
    --query appId -o tsv)
  green "  作成: appId=${APP_ID}"
fi

# 3. Service principal (enterprise application) — 無ければ作る
bold "==> Step 3/6: Service principal"
if az ad sp show --id "${APP_ID}" >/dev/null 2>&1; then
  green "  既存 SP を再利用"
else
  az ad sp create --id "${APP_ID}" --output none
  green "  作成完了"
fi

# 4. Admin consent
bold "==> Step 4/6: Admin consent"
echo "  Application.ReadWrite.All / User.Invite.All / AppRoleAssignment.ReadWrite.All"
echo "  に admin consent を付与します..."
if az ad app permission admin-consent --id "${APP_ID}" --output none 2>/dev/null; then
  green "  consent 完了"
else
  yellow "  admin-consent コマンドが失敗しました。"
  yellow "  権限不足の場合は Global Administrator に依頼するか Azure Portal で手動 consent してください:"
  yellow "    https://portal.azure.com → Microsoft Entra ID → App registrations → ${DISPLAY_NAME} → API permissions"
  read -r -p "  consent を Azure Portal で完了したら Enter (中止する場合は Ctrl-C): " _
fi

# 5. Client secret 生成 (1 年有効、説明: TenkaCloud-broker-bootstrap)
bold "==> Step 5/6: Client secret 生成"
SECRET_OUTPUT=$(az ad app credential reset \
  --id "${APP_ID}" \
  --display-name "TenkaCloud-broker-bootstrap" \
  --years 1 \
  --output json)
CLIENT_ID=$(echo "${SECRET_OUTPUT}" | jq -r .appId)
CLIENT_SECRET=$(echo "${SECRET_OUTPUT}" | jq -r .password)
[[ -n "${CLIENT_ID}" && -n "${CLIENT_SECRET}" ]] || die "client secret 取得に失敗"
green "  生成完了 (有効期限 1 年)"

# 6. SSM SecureString に保存
bold "==> Step 6/6: SSM SecureString に保存"
VALUE=$(jq -cn \
  --arg t "${TENANT_ID}" \
  --arg c "${CLIENT_ID}" \
  --arg s "${CLIENT_SECRET}" \
  '{TENANT_ID:$t, CLIENT_ID:$c, CLIENT_SECRET:$s}')
aws ssm put-parameter \
  --name "${BROKER_ENTRA_GRAPH_PARAMETER_NAME}" \
  --type SecureString \
  --value "${VALUE}" \
  --overwrite >/dev/null
green "  保存先: ${BROKER_ENTRA_GRAPH_PARAMETER_NAME}"

echo ""
bold "Bootstrap 完了"
echo ""
echo "  Tenant ID  : ${TENANT_ID}"
echo "  App ID     : ${CLIENT_ID}"
echo "  Profile ID : ${BROKER_ENTRA_PROFILE_ID}"
echo "  SSM        : ${BROKER_ENTRA_GRAPH_PARAMETER_NAME}"
echo ""
echo "  次のステップ:"
echo "    make deploy"
echo ""
if [[ "${BROKER_ENTRA_PROFILE_ID}" != "default" ]]; then
  yellow "  Note: profile を 'default' 以外で作ったので .env にこれを追加しておくと"
  yellow "        provision/deploy 系スクリプトが正しい profile を参照します:"
  yellow "          BROKER_ENTRA_PROFILE_ID=${BROKER_ENTRA_PROFILE_ID}"
fi
