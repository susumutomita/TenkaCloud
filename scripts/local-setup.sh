#!/bin/bash
# TenkaCloud Local Environment Setup
#
# クラウドエミュレータ（Kumo / LocalStack / Floci）を起動し、
# AWS CLI でインフラをセットアップする（Terraform 不使用）
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
NAME_PREFIX=tenkacloud-local
TABLE_NAME=TenkaCloud-local
EVENT_BUS_NAME=${NAME_PREFIX}-tenant-events

aws_cmd() {
  aws --endpoint-url="$EMULATOR_ENDPOINT" "$@"
}

# エミュレータの準備状態をチェック
check_emulator_ready() {
  case "$CLOUD_EMULATOR" in
    localstack)
      curl -s "$EMULATOR_ENDPOINT/_localstack/health" 2>/dev/null | grep -qE '"dynamodb": "(available|running)"'
      ;;
    kumo|floci)
      aws_cmd dynamodb list-tables >/dev/null 2>&1
      ;;
    *)
      echo "❌ 不明なエミュレータ: $CLOUD_EMULATOR"
      exit 1
      ;;
  esac
}

check_infrastructure_deployed() {
  aws_cmd dynamodb describe-table --table-name "$TABLE_NAME" >/dev/null 2>&1
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

# 3. AWS CLI でリソースを作成（Terraform 不使用）
echo ""
echo "🏗  Setting up infrastructure via AWS CLI..."

# --- DynamoDB ---
echo "📦 DynamoDB テーブルを作成中..."
aws_cmd dynamodb create-table \
  --table-name "$TABLE_NAME" \
  --attribute-definitions \
    AttributeName=PK,AttributeType=S \
    AttributeName=SK,AttributeType=S \
    AttributeName=GSI1PK,AttributeType=S \
    AttributeName=GSI1SK,AttributeType=S \
    AttributeName=EntityType,AttributeType=S \
    AttributeName=CreatedAt,AttributeType=S \
  --key-schema \
    AttributeName=PK,KeyType=HASH \
    AttributeName=SK,KeyType=RANGE \
  --global-secondary-indexes \
    '[
      {"IndexName":"GSI1","KeySchema":[{"AttributeName":"GSI1PK","KeyType":"HASH"},{"AttributeName":"GSI1SK","KeyType":"RANGE"}],"Projection":{"ProjectionType":"ALL"}},
      {"IndexName":"GSI2","KeySchema":[{"AttributeName":"EntityType","KeyType":"HASH"},{"AttributeName":"CreatedAt","KeyType":"RANGE"}],"Projection":{"ProjectionType":"ALL"}}
    ]' \
  --billing-mode PAY_PER_REQUEST \
  --stream-specification StreamEnabled=true,StreamViewType=NEW_AND_OLD_IMAGES \
  --region ap-northeast-1 \
  2>/dev/null || echo "  テーブル '$TABLE_NAME' は既に存在します"
echo "✅ DynamoDB 完了"

# --- S3 ---
echo "🪣 S3 バケットを作成中..."
aws_cmd s3 mb s3://${NAME_PREFIX}-data 2>/dev/null || echo "  バケット '${NAME_PREFIX}-data' は既に存在します"
echo "✅ S3 完了"

# --- SQS DLQ ---
echo "📬 SQS Dead Letter Queue を作成中..."
aws_cmd sqs create-queue --queue-name ${NAME_PREFIX}-provisioning-dlq 2>/dev/null || echo "  既存"
aws_cmd sqs create-queue --queue-name ${NAME_PREFIX}-tenant-provisioner-dlq 2>/dev/null || echo "  既存"
aws_cmd sqs create-queue --queue-name ${NAME_PREFIX}-provisioning-completion-dlq 2>/dev/null || echo "  既存"
echo "✅ SQS 完了"

# --- EventBridge ---
echo "🚌 EventBridge イベントバスを作成中..."
aws_cmd events create-event-bus --name "$EVENT_BUS_NAME" 2>/dev/null || echo "  バス '$EVENT_BUS_NAME' は既に存在します"
echo "✅ EventBridge バス完了"

# --- Lambda ---
echo "⚡ Lambda 関数を登録中..."
DUMMY_ROLE="arn:aws:iam::000000000000:role/dummy-lambda-role"

# Provisioning Lambda (Control Plane)
aws_cmd lambda create-function \
  --function-name ${NAME_PREFIX}-provisioning \
  --runtime nodejs20.x \
  --role "$DUMMY_ROLE" \
  --handler index.handler \
  --zip-file fileb://"$PROJECT_ROOT/backend/services/control-plane/provisioning/lambda.zip" \
  --timeout 60 \
  --memory-size 256 \
  --environment "Variables={EVENT_BUS_NAME=$EVENT_BUS_NAME,DYNAMODB_TABLE=$TABLE_NAME}" \
  2>/dev/null || \
aws_cmd lambda update-function-code \
  --function-name ${NAME_PREFIX}-provisioning \
  --zip-file fileb://"$PROJECT_ROOT/backend/services/control-plane/provisioning/lambda.zip" \
  2>/dev/null || echo "  Provisioning Lambda 登録スキップ（エミュレータ未対応）"

# Tenant Provisioner Lambda (Application Plane)
aws_cmd lambda create-function \
  --function-name ${NAME_PREFIX}-tenant-provisioner \
  --runtime nodejs20.x \
  --role "$DUMMY_ROLE" \
  --handler handler.handler \
  --zip-file fileb://"$PROJECT_ROOT/backend/services/application-plane/tenant-provisioner/lambda.zip" \
  --timeout 120 \
  --memory-size 256 \
  --environment "Variables={EVENT_BUS_NAME=$EVENT_BUS_NAME,DATA_BUCKET_NAME=${NAME_PREFIX}-data}" \
  2>/dev/null || \
aws_cmd lambda update-function-code \
  --function-name ${NAME_PREFIX}-tenant-provisioner \
  --zip-file fileb://"$PROJECT_ROOT/backend/services/application-plane/tenant-provisioner/lambda.zip" \
  2>/dev/null || echo "  Tenant Provisioner Lambda 登録スキップ（エミュレータ未対応）"

# Provisioning Completion Lambda (Control Plane)
aws_cmd lambda create-function \
  --function-name ${NAME_PREFIX}-provisioning-completion \
  --runtime nodejs20.x \
  --role "$DUMMY_ROLE" \
  --handler handler.handler \
  --zip-file fileb://"$PROJECT_ROOT/backend/services/control-plane/provisioning-completion/lambda.zip" \
  --timeout 30 \
  --memory-size 128 \
  --environment "Variables={DYNAMODB_TABLE=$TABLE_NAME}" \
  2>/dev/null || \
aws_cmd lambda update-function-code \
  --function-name ${NAME_PREFIX}-provisioning-completion \
  --zip-file fileb://"$PROJECT_ROOT/backend/services/control-plane/provisioning-completion/lambda.zip" \
  2>/dev/null || echo "  Provisioning Completion Lambda 登録スキップ（エミュレータ未対応）"

echo "✅ Lambda 完了"

# --- EventBridge ルールと Lambda ターゲット ---
echo "🔗 EventBridge ルールと Lambda ターゲットを設定中..."

ACCOUNT_ID=000000000000
REGION=ap-northeast-1
LAMBDA_BASE="arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function"

# TenantOnboarding → tenant-provisioner
aws_cmd events put-rule \
  --name ${NAME_PREFIX}-tenant-onboarding \
  --event-bus-name "$EVENT_BUS_NAME" \
  --event-pattern '{"source":["tenkacloud.control-plane"],"detail-type":["TenantOnboarding"]}' \
  2>/dev/null || echo "  ルール tenant-onboarding は既に存在します"

aws_cmd events put-targets \
  --rule ${NAME_PREFIX}-tenant-onboarding \
  --event-bus-name "$EVENT_BUS_NAME" \
  --targets "Id=tenant-provisioner,Arn=${LAMBDA_BASE}/${NAME_PREFIX}-tenant-provisioner" \
  2>/dev/null || echo "  ターゲット tenant-provisioner は既に存在します"

# TenantProvisioned → provisioning-completion
aws_cmd events put-rule \
  --name ${NAME_PREFIX}-tenant-provisioned \
  --event-bus-name "$EVENT_BUS_NAME" \
  --event-pattern '{"source":["tenkacloud.application-plane"],"detail-type":["TenantProvisioned"]}' \
  2>/dev/null || echo "  ルール tenant-provisioned は既に存在します"

aws_cmd events put-targets \
  --rule ${NAME_PREFIX}-tenant-provisioned \
  --event-bus-name "$EVENT_BUS_NAME" \
  --targets "Id=provisioning-completion,Arn=${LAMBDA_BASE}/${NAME_PREFIX}-provisioning-completion" \
  2>/dev/null || echo "  ターゲット provisioning-completion は既に存在します"

echo "✅ EventBridge ルール完了"

# --- DynamoDB Stream → Provisioning Lambda ---
echo "🔁 DynamoDB Stream トリガーを設定中..."
STREAM_ARN=$(aws_cmd dynamodb describe-table \
  --table-name "$TABLE_NAME" \
  --query 'Table.LatestStreamArn' \
  --output text 2>/dev/null || echo "")

if [ -n "$STREAM_ARN" ] && [ "$STREAM_ARN" != "None" ] && [ "$STREAM_ARN" != "null" ]; then
  aws_cmd lambda create-event-source-mapping \
    --event-source-arn "$STREAM_ARN" \
    --function-name ${NAME_PREFIX}-provisioning \
    --starting-position LATEST \
    --batch-size 10 \
    2>/dev/null || echo "  Stream トリガーは既に存在するかエミュレータ未対応"
  echo "✅ DynamoDB Stream トリガー完了"
else
  echo "  ⚠️  DynamoDB Stream ARN が取得できません（エミュレータ未対応の可能性）"
fi

# 4. 確認
echo ""
echo "🔍 デプロイ確認..."

echo ""
echo "DynamoDB Tables:"
aws_cmd dynamodb list-tables

echo ""
echo "Lambda Functions:"
aws_cmd lambda list-functions --query 'Functions[].FunctionName' 2>/dev/null || echo "  (Lambda 未対応)"

echo ""
echo "EventBridge Event Buses:"
aws_cmd events list-event-buses --query 'EventBuses[].Name' 2>/dev/null || echo "  (EventBridge 未対応)"

echo ""
echo "S3 Buckets:"
aws_cmd s3 ls 2>/dev/null || echo "  (S3 未対応)"

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
echo "  # テナント作成（プロビジョニングフロー全体を起動）"
echo "  make test-tenant"
echo ""
echo "  # Provisioning Lambda のログ確認"
echo "  make logs-local"
echo ""
