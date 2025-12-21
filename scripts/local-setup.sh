#!/bin/bash
# TenkaCloud Local Environment Setup
#
# LocalStack を起動し、Terraform でインフラをデプロイする

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "🚀 TenkaCloud Local Environment Setup"
echo "======================================"

# 1. LocalStack 起動
echo ""
echo "📦 Starting LocalStack..."
cd "$PROJECT_ROOT"
docker compose up -d localstack

# LocalStack が起動するまで待機
echo "⏳ Waiting for LocalStack to be ready..."
until curl -s http://localhost:4566/_localstack/health | grep -q '"dynamodb": "running"'; do
  sleep 2
  echo "   Waiting..."
done
echo "✅ LocalStack is ready!"

# 2. Lambda をビルド
echo ""
echo "🔨 Building Provisioning Lambda..."
cd "$PROJECT_ROOT/backend/services/control-plane/provisioning"
bun install
bun run deploy
echo "✅ Lambda built!"

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
aws --endpoint-url=http://localhost:4566 dynamodb list-tables --region ap-northeast-1

echo ""
echo "Lambda Functions:"
aws --endpoint-url=http://localhost:4566 lambda list-functions --region ap-northeast-1 --query 'Functions[].FunctionName'

echo ""
echo "EventBridge Event Buses:"
aws --endpoint-url=http://localhost:4566 events list-event-buses --region ap-northeast-1 --query 'EventBuses[].Name'

echo ""
echo "======================================"
echo "✅ Local environment is ready!"
echo ""
echo "Endpoints:"
echo "  - LocalStack:  http://localhost:4566"
echo "  - DynamoDB:    http://localhost:4566"
echo "  - Lambda:      http://localhost:4566"
echo ""
echo "Test commands:"
echo "  # Create a tenant (triggers Lambda via DynamoDB Stream)"
echo "  aws --endpoint-url=http://localhost:4566 dynamodb put-item \\"
echo "    --table-name TenkaCloud-local \\"
echo "    --item '{\"PK\":{\"S\":\"TENANT#test-tenant\"},\"SK\":{\"S\":\"METADATA\"},\"id\":{\"S\":\"test-tenant\"},\"name\":{\"S\":\"Test Tenant\"},\"slug\":{\"S\":\"test-tenant\"},\"tier\":{\"S\":\"FREE\"},\"status\":{\"S\":\"ACTIVE\"},\"provisioningStatus\":{\"S\":\"PENDING\"},\"EntityType\":{\"S\":\"TENANT\"},\"CreatedAt\":{\"S\":\"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'\"}}'"
echo ""
echo "  # Check Lambda logs"
echo "  aws --endpoint-url=http://localhost:4566 logs tail /aws/lambda/tenkacloud-local-provisioning --follow"
