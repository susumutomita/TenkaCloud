# shellcheck shell=bash
#
# Broker Entra (External Identities) の SSM パラメータ名・プロファイル ID を
# 全 deploy スクリプト共通で初期化するヘルパー。
#
# Usage:
#   SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
#   # shellcheck source=scripts/lib/broker-entra-env.sh
#   source "${SCRIPT_DIR}/lib/broker-entra-env.sh"
#   TenkaCloud_load_broker_entra_env
#
# Why a single source: install.sh / provision-tenant.sh / update-tenant.sh /
# ensure-broker-entra-ssm.sh は同じ default 群 (profile id / param 名) を持っていて、
# 1 つでも drift すると CDK が違う SSM SecureString を読みに行ってデプロイがコケる
# (実際 update-tenant.sh は profiles/default をハードコードしていた)。

TenkaCloud_validate_broker_entra_profile_id() {
  local id="${1:?profile id required}"
  if [[ ! "${id}" =~ ^[A-Za-z0-9._-]+$ ]]; then
    echo "ERROR: BROKER_ENTRA_PROFILE_ID must match ^[A-Za-z0-9._-]+\$: ${id}" >&2
    return 1
  fi
}

TenkaCloud_load_broker_entra_env() {
  export BROKER_ENTRA_PROFILE_ID="${BROKER_ENTRA_PROFILE_ID:-default}"
  TenkaCloud_validate_broker_entra_profile_id "${BROKER_ENTRA_PROFILE_ID}" || exit 1
  export BROKER_ENTRA_TENANT_CONFIG_PREFIX="${BROKER_ENTRA_TENANT_CONFIG_PREFIX:-/TenkaCloud/tenants}"
  export BROKER_ENTRA_GRAPH_PARAMETER_NAME="${BROKER_ENTRA_GRAPH_PARAMETER_NAME:-/TenkaCloud/broker-entra/profiles/${BROKER_ENTRA_PROFILE_ID}/graph-credentials}"
  export BROKER_ENTRA_APPLICATION_TEMPLATE_ID="${BROKER_ENTRA_APPLICATION_TEMPLATE_ID:-}"
  export CDK_PARAM_BROKER_ENTRA_TENANT_CONFIG_PREFIX="${BROKER_ENTRA_TENANT_CONFIG_PREFIX}"
  export CDK_PARAM_BROKER_ENTRA_GRAPH_PARAMETER_NAME="${BROKER_ENTRA_GRAPH_PARAMETER_NAME}"
  if [[ -n "${BROKER_ENTRA_APPLICATION_TEMPLATE_ID}" ]]; then
    export CDK_PARAM_BROKER_ENTRA_APPLICATION_TEMPLATE_ID="${BROKER_ENTRA_APPLICATION_TEMPLATE_ID}"
  fi
}
