#!/bin/bash
# TenkaCloud Local Environment Setup
#
# LocalStack を起動し、Terraform でインフラをデプロイする
# 冪等性: 既に起動・デプロイ済みの場合はスキップ

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# LocalStack 用ダミー認証情報
export AWS_ACCESS_KEY_ID=test
export AWS_SECRET_ACCESS_KEY=test
export AWS_DEFAULT_REGION=ap-northeast-1

# 既に LocalStack が起動しているかチェック
check_localstack_ready() {
  curl -s http://localhost:4566/_localstack/health 2>/dev/null | grep -qE '"dynamodb": "(available|running)"'
}

check_infrastructure_deployed() {
  # DynamoDB テーブルが存在するかチェック
  aws --endpoint-url=http://localhost:4566 dynamodb describe-table --table-name TenkaCloud-local >/dev/null 2>&1
}

echo "🚀 TenkaCloud Local Environment Setup"
echo "======================================"

# 既に起動済みかチェック
if check_localstack_ready && check_infrastructure_deployed; then
  echo ""
  echo "✅ LocalStack は既に起動しており、インフラもデプロイ済みです"
  echo ""
  echo "Endpoints:"
  echo "  - LocalStack:  http://localhost:4566"
  echo "  - DynamoDB:    http://localhost:4566"
  echo "  - Lambda:      http://localhost:4566"
  echo "  - S3:          http://localhost:4566"
  echo ""
  echo "💡 再デプロイが必要な場合は、まず make stop を実行してください"
  exit 0
fi

# 1. LocalStack 起動
echo ""
echo "📦 Starting LocalStack..."
cd "$PROJECT_ROOT"
docker compose up -d localstack

# LocalStack が起動するまで待機
echo "⏳ Waiting for LocalStack to be ready..."
MAX_RETRIES=30
RETRY_COUNT=0

until curl -s http://localhost:4566/_localstack/health | grep -qE '"dynamodb": "(available|running)"'; do
  RETRY_COUNT=$((RETRY_COUNT + 1))
  if [ $RETRY_COUNT -ge $MAX_RETRIES ]; then
    echo "❌ LocalStack did not start within expected time"
    exit 1
  fi
  sleep 2
  echo "   Waiting... ($RETRY_COUNT/$MAX_RETRIES)"
done
echo "✅ DynamoDB is ready!"

# Wait for Lambda service
echo "⏳ Waiting for Lambda service..."
RETRY_COUNT=0
until curl -s http://localhost:4566/_localstack/health | grep -q '"lambda": "available"'; do
  RETRY_COUNT=$((RETRY_COUNT + 1))
  if [ $RETRY_COUNT -ge $MAX_RETRIES ]; then
    echo "⚠️  Lambda service did not start, continuing anyway..."
    break
  fi
  sleep 2
  echo "   Waiting for Lambda... ($RETRY_COUNT/$MAX_RETRIES)"
done
echo "✅ Lambda is ready!"

# Wait for EventBridge service
echo "⏳ Waiting for EventBridge service..."
RETRY_COUNT=0
until curl -s http://localhost:4566/_localstack/health | grep -qE '"events": "(available|running)"'; do
  RETRY_COUNT=$((RETRY_COUNT + 1))
  if [ $RETRY_COUNT -ge $MAX_RETRIES ]; then
    echo "⚠️  EventBridge service did not start, continuing anyway..."
    break
  fi
  sleep 2
  echo "   Waiting for EventBridge... ($RETRY_COUNT/$MAX_RETRIES)"
done
echo "✅ EventBridge is ready!"

echo "✅ LocalStack services are ready!"

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
echo "🏗  Deploying infrastructure to LocalStack..."
cd "$PROJECT_ROOT/infrastructure/terraform/environments/local"
terraform init -upgrade
terraform apply -auto-approve
echo "✅ Infrastructure deployed!"

# 4. 確認
echo ""
echo "🔍 Verifying deployment..."

echo ""
echo "DynamoDB Tables:"
aws --endpoint-url=http://localhost:4566 dynamodb list-tables

echo ""
echo "Lambda Functions:"
aws --endpoint-url=http://localhost:4566 lambda list-functions --query 'Functions[].FunctionName'

echo ""
echo "EventBridge Event Buses:"
aws --endpoint-url=http://localhost:4566 events list-event-buses --query 'EventBuses[].Name'

echo ""
echo "S3 Buckets:"
aws --endpoint-url=http://localhost:4566 s3 ls

echo ""
echo "======================================"
echo "✅ Local environment is ready!"
echo ""
echo "Endpoints:"
echo "  - LocalStack:  http://localhost:4566"
echo "  - DynamoDB:    http://localhost:4566"
echo "  - Lambda:      http://localhost:4566"
echo "  - S3:          http://localhost:4566"
echo ""
echo "Architecture:"
echo "  Control Plane:     DynamoDB Stream → Provisioning Lambda → EventBridge"
echo "                     EventBridge → Provisioning Completion → DynamoDB"
echo "  Application Plane: EventBridge → Tenant Provisioner → S3 → EventBridge"
echo ""
echo "Test commands:"
echo "  # Create a tenant (triggers full provisioning flow)"
echo "  aws --endpoint-url=http://localhost:4566 dynamodb put-item \\"
echo "    --table-name TenkaCloud-local \\"
echo "    --item '{\"PK\":{\"S\":\"TENANT#test-tenant\"},\"SK\":{\"S\":\"METADATA\"},\"id\":{\"S\":\"test-tenant\"},\"name\":{\"S\":\"Test Tenant\"},\"slug\":{\"S\":\"test-tenant\"},\"tier\":{\"S\":\"FREE\"},\"status\":{\"S\":\"ACTIVE\"},\"provisioningStatus\":{\"S\":\"PENDING\"},\"EntityType\":{\"S\":\"TENANT\"},\"CreatedAt\":{\"S\":\"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'\"}}'"
echo ""
echo "  # Check Provisioning Lambda logs (Control Plane)"
echo "  aws --endpoint-url=http://localhost:4566 logs tail /aws/lambda/tenkacloud-local-provisioning --follow"
echo ""
echo "  # Check Tenant Provisioner logs (Application Plane)"
echo "  aws --endpoint-url=http://localhost:4566 logs tail /aws/lambda/tenkacloud-local-tenant-provisioner --follow"
echo ""
echo "  # Check Provisioning Completion logs (Control Plane)"
echo "  aws --endpoint-url=http://localhost:4566 logs tail /aws/lambda/tenkacloud-local-provisioning-completion --follow"
