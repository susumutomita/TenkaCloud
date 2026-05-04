#!/bin/bash
set -eo pipefail
#
# `make destroy` の一部として呼ばれる、broker テナント側 Microsoft Entra のクリーンアップ。
# TenkaCloud が runtime に Graph で作成した per-tenant Enterprise Application
# (`TenkaCloud *` displayName 群) を全て削除する。
#
# 削除しないもの:
#   - guest user 自体 (broker テナントの他用途を壊さないため)
#   - broker app registration 自体 (uninstall-broker-entra.sh で別途削除)
#
# best-effort: SSM に broker creds が無い / token 取得失敗 / DELETE 失敗 のいずれも
# warn だけで exit 0 して呼び出し元 (cleanup.sh) を止めない。

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/broker-entra-env.sh
source "${SCRIPT_DIR}/lib/broker-entra-env.sh"
TenkaCloud_load_broker_entra_env

log() { echo "[$(date +%H:%M:%S)] [broker-entra-cleanup] $*"; }

CREDS_JSON=$(aws ssm get-parameter \
  --name "${BROKER_ENTRA_GRAPH_PARAMETER_NAME}" \
  --with-decryption --query "Parameter.Value" --output text 2>/dev/null || true)

if [[ -z "${CREDS_JSON}" || "${CREDS_JSON}" == "None" ]]; then
  log "broker Entra credentials not found in SSM (${BROKER_ENTRA_GRAPH_PARAMETER_NAME}); skipping Entra cleanup"
  exit 0
fi

ENTRA_TENANT_ID=$(echo "${CREDS_JSON}" | jq -r .TENANT_ID)
ENTRA_CLIENT_ID=$(echo "${CREDS_JSON}" | jq -r .CLIENT_ID)
ENTRA_CLIENT_SECRET=$(echo "${CREDS_JSON}" | jq -r .CLIENT_SECRET)

if [[ -z "${ENTRA_TENANT_ID}" || -z "${ENTRA_CLIENT_ID}" || -z "${ENTRA_CLIENT_SECRET}" ]]; then
  log "broker Entra credentials malformed; skipping"
  exit 0
fi

TOKEN_RESPONSE=$(curl -sS -X POST \
  "https://login.microsoftonline.com/${ENTRA_TENANT_ID}/oauth2/v2.0/token" \
  -d "client_id=${ENTRA_CLIENT_ID}" \
  -d "client_secret=${ENTRA_CLIENT_SECRET}" \
  -d "grant_type=client_credentials" \
  -d "scope=https://graph.microsoft.com/.default" || echo "{}")
TOKEN=$(echo "${TOKEN_RESPONSE}" | jq -r '.access_token // empty')

if [[ -z "${TOKEN}" ]]; then
  log "failed to acquire Graph token (broker app registration may already be revoked); skipping"
  exit 0
fi

# `TenkaCloud ` prefix 一致で per-tenant Enterprise Application を列挙。
# applicationsTemplates(=gallery) を経由した instantiate でも普通の application object
# として返るので /applications で網羅できる。
APPS_JSON=$(curl -sS -H "Authorization: Bearer ${TOKEN}" \
  "https://graph.microsoft.com/v1.0/applications?\$filter=startswith(displayName,'TenkaCloud ')&\$select=id,displayName" \
  || echo '{"value":[]}')

APP_COUNT=$(echo "${APPS_JSON}" | jq '.value | length')
if [[ "${APP_COUNT}" == "0" ]]; then
  log "no TenkaCloud per-tenant Enterprise Apps in broker tenant; skip"
  exit 0
fi

log "deleting ${APP_COUNT} per-tenant Enterprise App(s) from broker tenant ${ENTRA_TENANT_ID}..."
echo "${APPS_JSON}" | jq -r '.value[] | "\(.id)\t\(.displayName)"' | while IFS=$'\t' read -r APP_OBJ_ID DISPLAY_NAME; do
  [[ -z "${APP_OBJ_ID}" ]] && continue
  STATUS=$(curl -sS -o /dev/null -w "%{http_code}" -X DELETE \
    -H "Authorization: Bearer ${TOKEN}" \
    "https://graph.microsoft.com/v1.0/applications/${APP_OBJ_ID}" || echo "000")
  case "${STATUS}" in
    204|404) log "  deleted: ${DISPLAY_NAME}" ;;
    *)       log "  failed (HTTP ${STATUS}): ${DISPLAY_NAME}" ;;
  esac
done

log "broker Entra cleanup complete."
