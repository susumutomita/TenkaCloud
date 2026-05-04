#!/bin/bash
set -eo pipefail

# Upsert a Microsoft Graph credential profile used by broker Entra tenants.
#
# Required once per environment:
#   BROKER_ENTRA_TENANT_ID
#   BROKER_ENTRA_CLIENT_ID
#   BROKER_ENTRA_CLIENT_SECRET
#
# Optional:
#   BROKER_ENTRA_PROFILE_ID (default: default)
#
# If the SSM parameter already exists, the values above may be omitted. This lets
# subsequent deploys reuse the existing SecureString without retyping the secret.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/broker-entra-env.sh
source "${SCRIPT_DIR}/lib/broker-entra-env.sh"
TenkaCloud_load_broker_entra_env
PROFILE_ID="${BROKER_ENTRA_PROFILE_ID}"
PARAM_NAME="${BROKER_ENTRA_GRAPH_PARAMETER_NAME}"

is_placeholder() {
  case "${1:-}" in
    "" | "..." | "<"*">" | "replace-me" | "REPLACE_ME")
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

has_existing_parameter() {
  aws ssm get-parameter --name "${PARAM_NAME}" --with-decryption >/dev/null 2>&1
}

if is_placeholder "${BROKER_ENTRA_TENANT_ID:-}" \
  || is_placeholder "${BROKER_ENTRA_CLIENT_ID:-}" \
  || is_placeholder "${BROKER_ENTRA_CLIENT_SECRET:-}"; then
  if has_existing_parameter; then
    echo "Broker Entra Graph credentials already exist in SSM: ${PARAM_NAME}"
    exit 0
  fi

  cat >&2 <<EOF
ERROR: Broker Entra Graph credentials are not configured.

推奨フロー (対話型 bootstrap):
  make bootstrap-broker-entra
    └ Azure に App registration / SP / admin-consent / client secret を作成して
      SSM SecureString に保存します (.env への secret 書き込み不要)。

または、手動で App registration 作成済みなら以下を
infrastructure/environments/<env>/.env に書いて再 make deploy:
  BROKER_ENTRA_TENANT_ID
  BROKER_ENTRA_CLIENT_ID
  BROKER_ENTRA_CLIENT_SECRET

Profile : ${PROFILE_ID}
SSM     : ${PARAM_NAME}
EOF
  exit 1
fi

VALUE=$(
  jq -cn \
    --arg TENANT_ID "${BROKER_ENTRA_TENANT_ID}" \
    --arg CLIENT_ID "${BROKER_ENTRA_CLIENT_ID}" \
    --arg CLIENT_SECRET "${BROKER_ENTRA_CLIENT_SECRET}" \
    '{TENANT_ID:$TENANT_ID,CLIENT_ID:$CLIENT_ID,CLIENT_SECRET:$CLIENT_SECRET}'
)

echo "Upserting Broker Entra Graph credentials profile '${PROFILE_ID}' to SSM SecureString: ${PARAM_NAME}"
aws ssm put-parameter \
  --name "${PARAM_NAME}" \
  --type SecureString \
  --value "${VALUE}" \
  --overwrite >/dev/null
