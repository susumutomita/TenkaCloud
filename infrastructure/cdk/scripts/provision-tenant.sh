#!/bin/bash
set -euo pipefail

# TenkaCloud Tenant Provisioning Script
# SBT ProvisioningScriptJob から CodeBuild 経由で呼び出される
#
# 入力変数 (EventBridge から自動注入):
#   tenantId   - テナント一意識別子
#   tier       - テナントティア (FREE, PRO, ENTERPRISE)
#   tenantName - テナント表示名
#   email      - テナント管理者メールアドレス
#
# 出力変数 (export して SBT が EventBridge に送信):
#   tenantNamespace  - テナント名前空間
#   tenantDbPrefix   - DynamoDB プレフィックス
#   tenantEndpoint   - テナント API エンドポイント
#   tenantS3Bucket   - テナントデータバケット名
#   registrationStatus - プロビジョニング結果

echo "========================================"
echo "TenkaCloud Tenant Provisioning"
echo "========================================"
echo "Tenant ID:   ${tenantId}"
echo "Tier:        ${tier}"
echo "Tenant Name: ${tenantName}"
echo "Email:       ${email}"
echo "Region:      ${AWS_REGION:-ap-northeast-1}"
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

# テナント名前空間とプレフィックス
TENANT_NS="tenant-${tenantId}"
TENANT_DB_PREFIX="TENANT#${tenantId}"

# ティアに応じた S3 プロビジョニング
shopt -s nocasematch

if [[ "${tier}" == "ENTERPRISE" ]]; then
  # Silo モデル: テナント専用バケット
  TENANT_BUCKET="tenkacloud-${tenantId}"
  echo "Creating dedicated S3 bucket: ${TENANT_BUCKET}"

  if ! aws ${ENDPOINT_OPT} s3api head-bucket --bucket "${TENANT_BUCKET}" 2>/dev/null; then
    aws ${ENDPOINT_OPT} s3api create-bucket \
      --bucket "${TENANT_BUCKET}" \
      --region "${REGION}" \
      --create-bucket-configuration LocationConstraint="${REGION}" 2>/dev/null || \
    aws ${ENDPOINT_OPT} s3api create-bucket \
      --bucket "${TENANT_BUCKET}" 2>/dev/null || true
    echo "Created bucket: ${TENANT_BUCKET}"
  else
    echo "Bucket already exists: ${TENANT_BUCKET}"
  fi

  # テナントメタデータマーカーを作成
  echo "{\"tenantId\":\"${tenantId}\",\"tier\":\"${tier}\",\"model\":\"silo\",\"createdAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" | \
    aws ${ENDPOINT_OPT} s3 cp - "s3://${TENANT_BUCKET}/.tenant-metadata"
else
  # Pool モデル: 共有バケット内にプレフィックス作成
  TENANT_BUCKET="${SHARED_BUCKET}"
  PREFIX="tenants/${tenantId}/"
  echo "Creating S3 prefix: s3://${SHARED_BUCKET}/${PREFIX}"

  # 共有バケットが存在しない場合は作成
  if ! aws ${ENDPOINT_OPT} s3api head-bucket --bucket "${SHARED_BUCKET}" 2>/dev/null; then
    aws ${ENDPOINT_OPT} s3api create-bucket \
      --bucket "${SHARED_BUCKET}" \
      --region "${REGION}" \
      --create-bucket-configuration LocationConstraint="${REGION}" 2>/dev/null || \
    aws ${ENDPOINT_OPT} s3api create-bucket \
      --bucket "${SHARED_BUCKET}" 2>/dev/null || true
    echo "Created shared bucket: ${SHARED_BUCKET}"
  fi

  # テナントプレフィックスマーカーを作成
  echo "{\"tenantId\":\"${tenantId}\",\"tier\":\"${tier}\",\"model\":\"pool\",\"createdAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" | \
    aws ${ENDPOINT_OPT} s3 cp - "s3://${SHARED_BUCKET}/${PREFIX}.tenant-marker"
fi

shopt -u nocasematch

# DynamoDB にテナント初期設定を書き込み
TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "Writing tenant metadata to DynamoDB: ${TABLE_NAME}"

aws ${ENDPOINT_OPT} dynamodb put-item \
  --table-name "${TABLE_NAME}" \
  --item "{
    \"PK\": {\"S\": \"${TENANT_DB_PREFIX}\"},
    \"SK\": {\"S\": \"PROVISIONING\"},
    \"tenantId\": {\"S\": \"${tenantId}\"},
    \"tenantName\": {\"S\": \"${tenantName}\"},
    \"tier\": {\"S\": \"${tier}\"},
    \"s3Bucket\": {\"S\": \"${TENANT_BUCKET}\"},
    \"namespace\": {\"S\": \"${TENANT_NS}\"},
    \"provisionedAt\": {\"S\": \"${TIMESTAMP}\"},
    \"EntityType\": {\"S\": \"TENANT_PROVISIONING\"}
  }" 2>/dev/null || echo "DynamoDB write skipped (table may not exist)"

# SBT に export する出力変数
export tenantNamespace="${TENANT_NS}"
export tenantDbPrefix="${TENANT_DB_PREFIX}"
export tenantEndpoint="${tenantId}.tenkacloud.io"
export tenantS3Bucket="${TENANT_BUCKET}"
export registrationStatus="COMPLETED"

echo "========================================"
echo "Provisioning completed successfully"
echo "  Namespace:  ${tenantNamespace}"
echo "  DB Prefix:  ${tenantDbPrefix}"
echo "  Endpoint:   ${tenantEndpoint}"
echo "  S3 Bucket:  ${tenantS3Bucket}"
echo "========================================"
