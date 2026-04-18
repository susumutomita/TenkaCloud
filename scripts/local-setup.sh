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
DYNAMODB_ENDPOINT="${DYNAMODB_ENDPOINT:-http://localhost:8000}"
NAME_PREFIX=tenkacloud-local
TABLE_NAME=TenkaCloud-local
EVENT_BUS_NAME=${NAME_PREFIX}-tenant-events

aws_cmd() {
  aws --endpoint-url="$EMULATOR_ENDPOINT" "$@"
}

dynamodb_cmd() {
  aws --endpoint-url="$DYNAMODB_ENDPOINT" "$@"
}

ensure_bun_dependencies() {
  if [ -d node_modules ]; then
    return
  fi
  bun install
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

check_dynamodb_ready() {
  dynamodb_cmd dynamodb list-tables >/dev/null 2>&1
}

check_infrastructure_deployed() {
  dynamodb_cmd dynamodb describe-table --table-name "$TABLE_NAME" >/dev/null 2>&1
}

echo "🚀 TenkaCloud Local Environment Setup"
echo "======================================"
echo "☁️  エミュレータ: $CLOUD_EMULATOR"

# 1. エミュレータ起動
echo ""
echo "📦 Starting $CLOUD_EMULATOR..."
cd "$PROJECT_ROOT"
COMPOSE_PROFILES="$CLOUD_EMULATOR" docker compose up -d "$CLOUD_EMULATOR" dynamodb-local

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

echo "⏳ Waiting for DynamoDB Local to be ready..."
RETRY_COUNT=0
until check_dynamodb_ready; do
  RETRY_COUNT=$((RETRY_COUNT + 1))
  if [ $RETRY_COUNT -ge $MAX_RETRIES ]; then
    echo "❌ DynamoDB Local did not start within expected time"
    exit 1
  fi
  sleep 2
  echo "   Waiting for DynamoDB Local... ($RETRY_COUNT/$MAX_RETRIES)"
done
echo "✅ DynamoDB Local is ready!"

# 2. Lambda ビルド（inline モードではスキップ）
# PROVISIONING_DELIVERY_MODE=inline の場合、Lambda は不要
# （tenant-management が直接 provisioning を実行する）
if [ "${PROVISIONING_DELIVERY_MODE:-inline}" != "inline" ]; then
  echo ""
  echo "🔨 Building Lambda functions..."
  for svc in \
    "$PROJECT_ROOT/server/application/microservices/tenant-management" \
  ; do
    if [ -d "$svc" ]; then
      cd "$svc"
      ensure_bun_dependencies
      echo "  ✅ $(basename "$svc")"
    fi
  done
  cd "$PROJECT_ROOT"
else
  echo ""
  echo "⏭  Lambda ビルドスキップ（PROVISIONING_DELIVERY_MODE=inline）"
fi

# 3. AWS CLI でリソースを作成（Terraform 不使用）
echo ""
echo "🏗  Setting up infrastructure via AWS CLI..."

# --- DynamoDB ---
echo "📦 DynamoDB テーブルを作成中..."
dynamodb_cmd dynamodb create-table \
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

# --- シードデータ ---
echo "🌱 シードデータを投入中..."
SEED_EVENT_ID="01JQLOCAL0000000000000001"
SEED_NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || python3 -c "from datetime import datetime, timezone; print(datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'))")
SEED_START="2026-04-01T09:00:00Z"
SEED_END="2026-12-31T18:00:00Z"

# Event シード（dev-tenant の GameDay イベント）
dynamodb_cmd dynamodb put-item \
  --table-name "$TABLE_NAME" \
  --item '{
    "PK":              {"S": "EVENT#'"$SEED_EVENT_ID"'"},
    "SK":              {"S": "METADATA"},
    "GSI1PK":          {"S": "TENANT#dev-tenant"},
    "GSI1SK":          {"S": "'"$SEED_START"'"},
    "EntityType":      {"S": "EVENT"},
    "CreatedAt":       {"S": "'"$SEED_NOW"'"},
    "UpdatedAt":       {"S": "'"$SEED_NOW"'"},
    "id":              {"S": "'"$SEED_EVENT_ID"'"},
    "externalId":      {"S": "evt-local-001"},
    "tenantId":        {"S": "dev-tenant"},
    "name":            {"S": "TenkaCloud ローカル GameDay 2026"},
    "type":            {"S": "GAMEDAY"},
    "status":          {"S": "ACTIVE"},
    "startTime":       {"S": "'"$SEED_START"'"},
    "endTime":         {"S": "'"$SEED_END"'"},
    "timezone":        {"S": "Asia/Tokyo"},
    "participantType": {"S": "TEAM"},
    "maxParticipants": {"N": "20"},
    "minTeamSize":     {"N": "2"},
    "maxTeamSize":     {"N": "4"},
    "cloudProvider":   {"S": "AWS"},
    "regions":         {"L": [{"S": "ap-northeast-1"}]},
    "scoringType":     {"S": "REALTIME"},
    "scoringIntervalMinutes": {"N": "5"},
    "leaderboardVisible": {"BOOL": true},
    "createdBy":       {"S": "local-seed"}
  }' \
  2>/dev/null && echo "  イベントシード完了" || echo "  イベントシードはスキップ（既存）"

# GameDay 状態シード（gameday-service 用）
dynamodb_cmd dynamodb put-item \
  --table-name "$TABLE_NAME" \
  --item '{
    "PK":             {"S": "GAMEDAY#'"$SEED_EVENT_ID"'"},
    "SK":             {"S": "METADATA"},
    "GSI1PK":         {"S": "TENANT#dev-tenant#GAMEDAY"},
    "GSI1SK":         {"S": "'"$SEED_START"'"},
    "EntityType":     {"S": "GAMEDAY"},
    "CreatedAt":      {"S": "'"$SEED_NOW"'"},
    "UpdatedAt":      {"S": "'"$SEED_NOW"'"},
    "eventId":        {"S": "'"$SEED_EVENT_ID"'"},
    "tenantId":       {"S": "dev-tenant"},
    "isRunning":      {"BOOL": false},
    "startedAt":      {"NULL": true},
    "scoreWeight":    {"S": "normal"},
    "blackout":       {"BOOL": false},
    "durationMinutes": {"N": "120"}
  }' \
  2>/dev/null && echo "  GameDay シード完了" || echo "  GameDay シードはスキップ（既存）"

echo "✅ シードデータ完了"

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

# --- Lambda / EventBridge ルール ---
# inline モードではスキップ（tenant-management が直接処理）
if [ "${PROVISIONING_DELIVERY_MODE:-inline}" != "inline" ]; then
  echo "⚡ Lambda 関数と EventBridge ルールを登録中..."
  echo "  ⚠️  eventbridge モード: CDK デプロイが必要です (cd server && make deploy)"
else
  echo "⏭  Lambda/EventBridge 登録スキップ（inline モード）"
fi

# 4. 確認
echo ""
echo "🔍 デプロイ確認..."

echo ""
echo "DynamoDB Tables:"
dynamodb_cmd dynamodb list-tables

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
echo "  - DynamoDB:    $DYNAMODB_ENDPOINT"
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
