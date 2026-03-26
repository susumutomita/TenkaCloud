#!/bin/bash
# TenkaCloud Local Environment Setup
#
# クラウドエミュレータ（Kumo / LocalStack / Floci）を起動し、
# Terraform でインフラをデプロイする
# 冪等性: 既に起動・デプロイ済みの場合はスキップ
#
# 使い方:
#   CLOUD_EMULATOR=kumo ./scripts/local-setup.sh       # Kumo（デフォルト）
#   CLOUD_EMULATOR=localstack ./scripts/local-setup.sh  # LocalStack
#   CLOUD_EMULATOR=floci ./scripts/local-setup.sh       # Floci

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# エミュレータ選択（デフォルト: kumo）
CLOUD_EMULATOR="${CLOUD_EMULATOR:-kumo}"

# ダミー認証情報
export AWS_ACCESS_KEY_ID=test
export AWS_SECRET_ACCESS_KEY=test
export AWS_DEFAULT_REGION=ap-northeast-1

EMULATOR_ENDPOINT=http://localhost:4566

# エミュレータの準備状態をチェック
check_emulator_ready() {
  case "$CLOUD_EMULATOR" in
    localstack)
      curl -s "$EMULATOR_ENDPOINT/_localstack/health" 2>/dev/null | grep -qE '"dynamodb": "(available|running)"'
      ;;
    kumo|floci)
      aws --endpoint-url="$EMULATOR_ENDPOINT" dynamodb list-tables >/dev/null 2>&1
      ;;
    *)
      echo "❌ 不明なエミュレータ: $CLOUD_EMULATOR"
      exit 1
      ;;
  esac
}

check_infrastructure_deployed() {
  aws --endpoint-url="$EMULATOR_ENDPOINT" dynamodb describe-table --table-name TenkaCloud-local >/dev/null 2>&1
}

echo "🚀 TenkaCloud Local Environment Setup"
echo "======================================"
echo "☁️  エミュレータ: $CLOUD_EMULATOR"

# 既に起動済みかチェック
if check_emulator_ready && check_infrastructure_deployed; then
  echo ""
  echo "✅ $CLOUD_EMULATOR は既に起動しており、インフラもデプロイ済みです"
  echo ""
  echo "Endpoints:"
  echo "  - Emulator:    $EMULATOR_ENDPOINT"
  echo "  - DynamoDB:    $EMULATOR_ENDPOINT"
  echo "  - S3:          $EMULATOR_ENDPOINT"
  echo ""
  echo "💡 再デプロイが必要な場合は、まず make stop を実行してください"
  exit 0
fi

# 1. エミュレータ起動
echo ""
echo "📦 Starting $CLOUD_EMULATOR..."
cd "$PROJECT_ROOT"
COMPOSE_PROFILES="$CLOUD_EMULATOR" docker compose up -d

# エミュレータが起動するまで待機
echo "⏳ Waiting for $CLOUD_EMULATOR to be ready..."
MAX_RETRIES=30
RETRY_COUNT=0

until check_emulator_ready; do
  RETRY_COUNT=$((RETRY_COUNT + 1))
  if [ $RETRY_COUNT -ge $MAX_RETRIES ]; then
    echo "❌ $CLOUD_EMULATOR did not start within expected time"
    exit 1
  fi
  sleep 2
  echo "   Waiting... ($RETRY_COUNT/$MAX_RETRIES)"
done
echo "✅ $CLOUD_EMULATOR is ready!"

# LocalStack 以外はリソース初期化スクリプトを実行
# （LocalStack は init.sh をマウントして自動実行される）
if [ "$CLOUD_EMULATOR" != "localstack" ]; then
  echo ""
  echo "📦 リソースを初期化中..."
  "$SCRIPT_DIR/cloud-emulator-init.sh"
fi

# 2. Lambda をビルド
echo ""
echo "🔨 Building Provisioning Lambda (Control Plane)..."
cd "$PROJECT_ROOT/backend/services/control-plane/provisioning"
bun install
bun run deploy
echo "✅ Provisioning Lambda built!"

echo ""
echo "🔨 Building Tenant Provisioner Lambda (Application Plane)..."
cd "$PROJECT_ROOT/backend/services/application-plane/tenant-provisioner"
bun install
bun run deploy
echo "✅ Tenant Provisioner Lambda built!"

echo ""
echo "🔨 Building Provisioning Completion Lambda (Control Plane)..."
cd "$PROJECT_ROOT/backend/services/control-plane/provisioning-completion"
bun install
bun run deploy
echo "✅ Provisioning Completion Lambda built!"

# 3. Terraform でデプロイ
echo ""
echo "🏗  Deploying infrastructure to $CLOUD_EMULATOR..."
cd "$PROJECT_ROOT/infrastructure/terraform/environments/local"
terraform init -upgrade
terraform apply -auto-approve
echo "✅ Infrastructure deployed!"

# 4. 確認
echo ""
echo "🔍 Verifying deployment..."

echo ""
echo "DynamoDB Tables:"
aws --endpoint-url="$EMULATOR_ENDPOINT" dynamodb list-tables

echo ""
echo "Lambda Functions:"
aws --endpoint-url="$EMULATOR_ENDPOINT" lambda list-functions --query 'Functions[].FunctionName' 2>/dev/null || echo "  (Lambda 未対応)"

echo ""
echo "EventBridge Event Buses:"
aws --endpoint-url="$EMULATOR_ENDPOINT" events list-event-buses --query 'EventBuses[].Name' 2>/dev/null || echo "  (EventBridge 未対応)"

echo ""
echo "S3 Buckets:"
aws --endpoint-url="$EMULATOR_ENDPOINT" s3 ls 2>/dev/null || echo "  (S3 未対応)"

echo ""
echo "======================================"
echo "✅ Local environment is ready!"
echo ""
echo "Emulator: $CLOUD_EMULATOR"
echo "Endpoints:"
echo "  - Emulator:    $EMULATOR_ENDPOINT"
echo "  - DynamoDB:    $EMULATOR_ENDPOINT"
echo "  - S3:          $EMULATOR_ENDPOINT"
echo ""
echo "Architecture:"
echo "  Control Plane:     DynamoDB Stream → Provisioning Lambda → EventBridge"
echo "                     EventBridge → Provisioning Completion → DynamoDB"
echo "  Application Plane: EventBridge → Tenant Provisioner → S3 → EventBridge"
echo ""
echo "Test commands:"
echo "  # Create a tenant (triggers full provisioning flow)"
echo "  aws --endpoint-url=$EMULATOR_ENDPOINT dynamodb put-item \\"
echo "    --table-name TenkaCloud-local \\"
echo "    --item '{\"PK\":{\"S\":\"TENANT#test-tenant\"},\"SK\":{\"S\":\"METADATA\"},\"id\":{\"S\":\"test-tenant\"},\"name\":{\"S\":\"Test Tenant\"},\"slug\":{\"S\":\"test-tenant\"},\"tier\":{\"S\":\"FREE\"},\"status\":{\"S\":\"ACTIVE\"},\"provisioningStatus\":{\"S\":\"PENDING\"},\"EntityType\":{\"S\":\"TENANT\"},\"CreatedAt\":{\"S\":\"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'\"}}'"
echo ""
echo "  # Check Provisioning Lambda logs (Control Plane)"
echo "  aws --endpoint-url=$EMULATOR_ENDPOINT logs tail /aws/lambda/tenkacloud-local-provisioning --follow"
echo ""
