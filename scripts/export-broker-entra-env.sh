#!/bin/bash
set -eo pipefail
#
# bootstrap-broker-entra で SSM SecureString に保存した broker creds を、
# 別 AWS アカウントの operator に引き渡す目的で、`.env` に貼れる形式
# (BROKER_ENTRA_* prefix 付き) で標準出力する。
#
# Usage:
#   make export-broker-entra-env
#   # または
#   bash scripts/export-broker-entra-env.sh
#
# Output 例 (そのまま deployer の .env に追記してもらう):
#   BROKER_ENTRA_TENANT_ID=ed53966d-...
#   BROKER_ENTRA_CLIENT_ID=6b049d9f-...
#   BROKER_ENTRA_CLIENT_SECRET=xxxxx
#
# 注意:
#   - 出力は client_secret を含むので、ターミナル history / 画面共有 / Slack 等に
#     漏らさないこと。1Password などのセキュア共有経由で deployer に渡す前提。
#   - cross-account の deployer 側では `.env` に貼って `make deploy` すると、
#     install.sh → ensure-broker-entra-ssm.sh が deployer の AWS アカウント側の
#     SSM SecureString に put してくれる。以降は SSM が source of truth。

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/broker-entra-env.sh
source "${SCRIPT_DIR}/lib/broker-entra-env.sh"
TenkaCloud_load_broker_entra_env

CREDS_JSON=$(aws ssm get-parameter \
  --name "${BROKER_ENTRA_GRAPH_PARAMETER_NAME}" \
  --with-decryption --query "Parameter.Value" --output text 2>/dev/null || true)

if [[ -z "${CREDS_JSON}" || "${CREDS_JSON}" == "None" ]]; then
  cat >&2 <<EOF
ERROR: SSM SecureString が見つかりません。

  Profile : ${BROKER_ENTRA_PROFILE_ID}
  SSM     : ${BROKER_ENTRA_GRAPH_PARAMETER_NAME}

先に \`make bootstrap-broker-entra\` を流して broker creds を作成してください。
EOF
  exit 1
fi

TENANT_ID=$(echo "${CREDS_JSON}" | jq -r '.TENANT_ID // empty')
CLIENT_ID=$(echo "${CREDS_JSON}" | jq -r '.CLIENT_ID // empty')
CLIENT_SECRET=$(echo "${CREDS_JSON}" | jq -r '.CLIENT_SECRET // empty')

if [[ -z "${TENANT_ID}" || -z "${CLIENT_ID}" || -z "${CLIENT_SECRET}" ]]; then
  echo "ERROR: SSM の JSON が壊れている (TENANT_ID/CLIENT_ID/CLIENT_SECRET の一部が空)" >&2
  exit 1
fi

cat <<EOF
# === broker Entra credentials (export from SSM) ===
# 取り扱い注意: 以下を deployer の infrastructure/environments/<env>/.env に
# 追記して \`make deploy\` を実行してもらう。SecureString に貼り付けたあとは
# .env 側の broker 行は消して構わない (以降は deployer 側の SSM が source of truth)。
BROKER_ENTRA_TENANT_ID=${TENANT_ID}
BROKER_ENTRA_CLIENT_ID=${CLIENT_ID}
BROKER_ENTRA_CLIENT_SECRET=${CLIENT_SECRET}
EOF
