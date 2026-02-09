#!/bin/bash
set -euo pipefail

# TenkaCloud Tenant Deprovisioning Script
# SBT DeprovisioningScriptJob から CodeBuild 経由で呼び出される
#
# 入力変数 (EventBridge から自動注入):
#   tenantId - テナント一意識別子
#   tier     - テナントティア (FREE, PRO, ENTERPRISE)
#
# 出力変数 (export して SBT が EventBridge に送信):
#   registrationStatus - デプロビジョニング結果

echo "========================================"
echo "TenkaCloud Tenant Deprovisioning"
echo "========================================"
echo "Tenant ID: ${tenantId}"
echo "Tier:      ${tier}"
echo "Region:    ${AWS_REGION:-ap-northeast-1}"
echo "========================================"

REGION="${AWS_REGION:-ap-northeast-1}"
SHARED_BUCKET="tenkacloud-data"
TABLE_NAME="TenkaCloud"
ENDPOINT_OPT=""

# LocalStack 対応
if [ -n "${AWS_ENDPOINT_URL:-}" ]; then
  ENDPOINT_OPT="--endpoint-url ${AWS_ENDPOINT_URL}"
  TABLE_NAME="TenkaCloud-local"
  echo "LocalStack mode: endpoint=${AWS_ENDPOINT_URL}"
fi

TENANT_DB_PREFIX="TENANT#${tenantId}"

# ティアに応じた S3 クリーンアップ
shopt -s nocasematch

if [[ "${tier}" == "ENTERPRISE" ]]; then
  # Silo モデル: テナント専用バケットを空にして削除
  TENANT_BUCKET="tenkacloud-${tenantId}"
  echo "Cleaning up dedicated bucket: ${TENANT_BUCKET}"

  if aws ${ENDPOINT_OPT} s3api head-bucket --bucket "${TENANT_BUCKET}" 2>/dev/null; then
    # バケット内のオブジェクトをすべて削除
    aws ${ENDPOINT_OPT} s3 rm "s3://${TENANT_BUCKET}" --recursive 2>/dev/null || true
    # バケットを削除
    aws ${ENDPOINT_OPT} s3api delete-bucket --bucket "${TENANT_BUCKET}" 2>/dev/null || true
    echo "Deleted bucket: ${TENANT_BUCKET}"
  else
    echo "Bucket does not exist: ${TENANT_BUCKET}"
  fi
else
  # Pool モデル: 共有バケット内のテナントプレフィックスを削除
  PREFIX="tenants/${tenantId}/"
  echo "Cleaning up S3 prefix: s3://${SHARED_BUCKET}/${PREFIX}"

  aws ${ENDPOINT_OPT} s3 rm "s3://${SHARED_BUCKET}/${PREFIX}" --recursive 2>/dev/null || true
  echo "Deleted prefix: ${PREFIX}"
fi

shopt -u nocasematch

# DynamoDB からテナント関連レコードを削除
echo "Cleaning up DynamoDB records for: ${TENANT_DB_PREFIX}"

# PROVISIONING レコードを削除
aws ${ENDPOINT_OPT} dynamodb delete-item \
  --table-name "${TABLE_NAME}" \
  --key "{
    \"PK\": {\"S\": \"${TENANT_DB_PREFIX}\"},
    \"SK\": {\"S\": \"PROVISIONING\"}
  }" 2>/dev/null || echo "DynamoDB delete skipped (record may not exist)"

# SBT に export する出力変数
export registrationStatus="DELETED"

echo "========================================"
echo "Deprovisioning completed successfully"
echo "  Tenant ID: ${tenantId}"
echo "  Status:    DELETED"
echo "========================================"
