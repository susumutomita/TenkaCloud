#!/bin/bash
# クラウドエミュレータ初期化スクリプト（Kumo / Floci 共用）
# 標準 AWS CLI を使用してリソースを作成する
# LocalStack は独自の init.sh を使うため、このスクリプトは対象外

set -euo pipefail

echo "🚀 クラウドエミュレータ初期化を開始..."

ENDPOINT_URL="${AWS_ENDPOINT_URL:-http://localhost:4566}"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-ap-northeast-1}"
export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-test}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-test}"

aws_cmd() {
  aws --endpoint-url="$ENDPOINT_URL" "$@"
}

# ============================================
# DynamoDB テーブル作成（Single-Table Design）
# ============================================
echo "📦 DynamoDB テーブルを作成中..."

aws_cmd dynamodb create-table \
  --table-name TenkaCloud-dev \
  --attribute-definitions \
    AttributeName=PK,AttributeType=S \
    AttributeName=SK,AttributeType=S \
    AttributeName=GSI1PK,AttributeType=S \
    AttributeName=GSI1SK,AttributeType=S \
    AttributeName=EntityType,AttributeType=S \
  --key-schema \
    AttributeName=PK,KeyType=HASH \
    AttributeName=SK,KeyType=RANGE \
  --global-secondary-indexes \
    "[
      {\"IndexName\": \"GSI1\", \"KeySchema\": [{\"AttributeName\": \"GSI1PK\", \"KeyType\": \"HASH\"}, {\"AttributeName\": \"GSI1SK\", \"KeyType\": \"RANGE\"}], \"Projection\": {\"ProjectionType\": \"ALL\"}},
      {\"IndexName\": \"GSI2\", \"KeySchema\": [{\"AttributeName\": \"EntityType\", \"KeyType\": \"HASH\"}, {\"AttributeName\": \"SK\", \"KeyType\": \"RANGE\"}], \"Projection\": {\"ProjectionType\": \"ALL\"}}
    ]" \
  --billing-mode PAY_PER_REQUEST \
  2>/dev/null || echo "  テーブル 'TenkaCloud-dev' は既に存在します"

echo "✅ DynamoDB テーブル作成完了"

# ============================================
# Cognito ユーザープール作成
# ============================================
echo "👤 Cognito ユーザープールを作成中..."

USER_POOL_ID=$(aws_cmd cognito-idp create-user-pool \
  --pool-name tenkacloud-users \
  --policies '{"PasswordPolicy":{"MinimumLength":8,"RequireUppercase":true,"RequireLowercase":true,"RequireNumbers":true,"RequireSymbols":false}}' \
  --auto-verified-attributes email \
  --username-attributes email \
  --query 'UserPool.Id' \
  --output text \
  2>/dev/null || echo "")

if [ -n "$USER_POOL_ID" ] && [ "$USER_POOL_ID" != "" ]; then
  echo "  ユーザープール作成: $USER_POOL_ID"

  CLIENT_ID=$(aws_cmd cognito-idp create-user-pool-client \
    --user-pool-id "$USER_POOL_ID" \
    --client-name tenkacloud-app \
    --generate-secret \
    --explicit-auth-flows ALLOW_USER_PASSWORD_AUTH ALLOW_REFRESH_TOKEN_AUTH \
    --query 'UserPoolClient.ClientId' \
    --output text \
    2>/dev/null || echo "")

  if [ -n "$CLIENT_ID" ]; then
    echo "  アプリクライアント作成: $CLIENT_ID"
  fi
else
  echo "  ⚠️  Cognito 未対応またはエラー（スキップ）"
fi

echo "✅ Cognito セットアップ完了"

# ============================================
# S3 バケット作成
# ============================================
echo "🪣 S3 バケットを作成中..."

aws_cmd s3 mb s3://tenkacloud-assets 2>/dev/null || echo "  バケット 'tenkacloud-assets' は既に存在します"
aws_cmd s3 mb s3://tenkacloud-uploads 2>/dev/null || echo "  バケット 'tenkacloud-uploads' は既に存在します"
aws_cmd s3 mb s3://tenkacloud-logs 2>/dev/null || echo "  バケット 'tenkacloud-logs' は既に存在します"

echo "✅ S3 バケット作成完了"

# ============================================
# SQS キュー作成
# ============================================
echo "📬 SQS キューを作成中..."

aws_cmd sqs create-queue --queue-name battle-events 2>/dev/null || echo "  キュー 'battle-events' は既に存在するかエミュレータ未対応"
aws_cmd sqs create-queue --queue-name scoring-tasks 2>/dev/null || echo "  キュー 'scoring-tasks' は既に存在するかエミュレータ未対応"

echo "✅ SQS キュー作成完了"

# ============================================
# EventBridge イベントバス作成
# ============================================
echo "🚌 EventBridge イベントバスを作成中..."

aws_cmd events create-event-bus --name tenkacloud-events 2>/dev/null || echo "  イベントバス 'tenkacloud-events' は既に存在するかエミュレータ未対応"

echo "✅ EventBridge セットアップ完了"

# ============================================
# 初期化完了
# ============================================
echo ""
echo "🎉 クラウドエミュレータ初期化が完了しました！"
echo ""
echo "利用可能なリソース:"
echo "  - DynamoDB: TenkaCloud-dev (Single-Table Design with GSI1, GSI2)"
echo "  - Cognito: tenkacloud-users（対応エミュレータのみ）"
echo "  - S3: tenkacloud-assets, tenkacloud-uploads, tenkacloud-logs"
echo "  - SQS: battle-events, scoring-tasks（対応エミュレータのみ）"
echo "  - EventBridge: tenkacloud-events（対応エミュレータのみ）"
echo ""
echo "エンドポイント: $ENDPOINT_URL"
