#!/bin/bash
# LocalStack 初期化スクリプト
# このスクリプトは LocalStack 起動時に自動実行される
# /etc/localstack/init/ready.d/ にマウントして使用

set -euo pipefail

echo "🚀 LocalStack 初期化を開始..."

# AWS CLI のエンドポイント設定
export AWS_ENDPOINT_URL=http://localhost:4566
export AWS_DEFAULT_REGION=ap-northeast-1
export AWS_ACCESS_KEY_ID=test
export AWS_SECRET_ACCESS_KEY=test

# ============================================
# DynamoDB テーブル作成（Single-Table Design）
# ============================================
echo "📦 DynamoDB テーブルを作成中..."

# メインテーブル（Single-Table Design）
# PK/SK: プライマリキー
# GSI1PK/GSI1SK: スラッグベースのクエリ用
# EntityType: エンティティタイプ別クエリ用（GSI2）
awslocal dynamodb create-table \
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

USER_POOL_ID=$(awslocal cognito-idp create-user-pool \
  --pool-name tenkacloud-users \
  --policies '{"PasswordPolicy":{"MinimumLength":8,"RequireUppercase":true,"RequireLowercase":true,"RequireNumbers":true,"RequireSymbols":false}}' \
  --auto-verified-attributes email \
  --username-attributes email \
  --query 'UserPool.Id' \
  --output text \
  2>/dev/null || echo "")

if [ -n "$USER_POOL_ID" ] && [ "$USER_POOL_ID" != "" ]; then
  echo "  ユーザープール作成: $USER_POOL_ID"

  # アプリクライアント作成
  CLIENT_ID=$(awslocal cognito-idp create-user-pool-client \
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
  echo "  ユーザープール 'tenkacloud-users' は既に存在するかエラーが発生しました"
fi

echo "✅ Cognito セットアップ完了"

# ============================================
# S3 バケット作成
# ============================================
echo "🪣 S3 バケットを作成中..."

awslocal s3 mb s3://tenkacloud-assets 2>/dev/null || echo "  バケット 'tenkacloud-assets' は既に存在します"
awslocal s3 mb s3://tenkacloud-uploads 2>/dev/null || echo "  バケット 'tenkacloud-uploads' は既に存在します"
awslocal s3 mb s3://tenkacloud-logs 2>/dev/null || echo "  バケット 'tenkacloud-logs' は既に存在します"

echo "✅ S3 バケット作成完了"

# ============================================
# SQS キュー作成
# ============================================
echo "📬 SQS キューを作成中..."

awslocal sqs create-queue --queue-name battle-events 2>/dev/null || echo "  キュー 'battle-events' は既に存在します"
awslocal sqs create-queue --queue-name scoring-tasks 2>/dev/null || echo "  キュー 'scoring-tasks' は既に存在します"

echo "✅ SQS キュー作成完了"

# ============================================
# EventBridge イベントバス作成
# ============================================
echo "🚌 EventBridge イベントバスを作成中..."

awslocal events create-event-bus --name tenkacloud-events 2>/dev/null || echo "  イベントバス 'tenkacloud-events' は既に存在します"

echo "✅ EventBridge セットアップ完了"

# ============================================
# 初期化完了
# ============================================
echo ""
echo "🎉 LocalStack 初期化が完了しました！"
echo ""
echo "利用可能なリソース:"
echo "  - DynamoDB: TenkaCloud-dev (Single-Table Design with GSI1, GSI2)"
echo "  - Cognito: tenkacloud-users"
echo "  - S3: tenkacloud-assets, tenkacloud-uploads, tenkacloud-logs"
echo "  - SQS: battle-events, scoring-tasks"
echo "  - EventBridge: tenkacloud-events"
echo ""
echo "エンドポイント: http://localhost:4566"
