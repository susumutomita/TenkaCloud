#!/bin/bash
set -eo pipefail
#
# bootstrap-broker-entra.sh の逆操作。broker 用 App registration を Azure 側で削除し、
# 対応する SSM SecureString も削除する。per-tenant Enterprise App は別途
# `make destroy` (cleanup-broker-entra-tenants.sh) で削除されるので、その後で本
# script を流す想定。
#
# Usage:
#   make uninstall-broker-entra
#   bash scripts/uninstall-broker-entra.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/broker-entra-env.sh
source "${SCRIPT_DIR}/lib/broker-entra-env.sh"
TenkaCloud_load_broker_entra_env

bold()   { printf "\033[1m%s\033[0m\n" "$*"; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }
green()  { printf "\033[32m%s\033[0m\n" "$*"; }
die()    { printf "\033[31mERROR:\033[0m %s\n" "$*" >&2; exit 1; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "$1 が見つかりません"
}
require_cmd az
require_cmd aws
require_cmd jq

DISPLAY_NAME="TenkaCloud Broker (${BROKER_ENTRA_PROFILE_ID})"

bold "==> Uninstall broker Entra App registration"
echo "  Profile      : ${BROKER_ENTRA_PROFILE_ID}"
echo "  Display name : ${DISPLAY_NAME}"
echo "  SSM          : ${BROKER_ENTRA_GRAPH_PARAMETER_NAME}"
echo ""
yellow "削除対象:"
yellow "  1. Azure 側: ${DISPLAY_NAME} の App registration + SP"
yellow "  2. AWS 側  : SSM SecureString ${BROKER_ENTRA_GRAPH_PARAMETER_NAME}"
echo ""
yellow "Note: per-tenant Enterprise App (\`TenkaCloud <UserPoolId> ...\`) は本 script では消えません。"
yellow "      先に \`make destroy\` を流して全部消してから本 script を実行してください。"
echo ""
read -r -p "本当に削除しますか? [y/N]: " confirm
if [[ ! "${confirm,,}" =~ ^y(es)?$ ]]; then
  echo "中断しました。"
  exit 0
fi

# 1. az login
bold "==> Step 1/3: Azure へログイン (device code flow)"
# --allow-no-subscriptions: Entra-only テナント (Azure subscription 無し) でも sign-in 可能に。
az login --use-device-code --allow-no-subscriptions --output none

# 2. App 削除
bold "==> Step 2/3: App registration 削除"
APP_ID=$(az ad app list --display-name "${DISPLAY_NAME}" --query "[0].appId" -o tsv 2>/dev/null || true)
if [[ -n "${APP_ID}" ]]; then
  az ad app delete --id "${APP_ID}" --output none
  green "  deleted: ${DISPLAY_NAME} (appId=${APP_ID})"
else
  yellow "  app not found (already deleted?); skip"
fi

# 3. SSM 削除
bold "==> Step 3/3: SSM SecureString 削除"
if aws ssm get-parameter --name "${BROKER_ENTRA_GRAPH_PARAMETER_NAME}" >/dev/null 2>&1; then
  aws ssm delete-parameter --name "${BROKER_ENTRA_GRAPH_PARAMETER_NAME}"
  green "  deleted: ${BROKER_ENTRA_GRAPH_PARAMETER_NAME}"
else
  yellow "  SSM parameter not found; skip"
fi

echo ""
bold "Uninstall 完了"
