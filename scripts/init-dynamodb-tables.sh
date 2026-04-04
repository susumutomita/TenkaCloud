#!/bin/bash
# DynamoDB テーブル初期化スクリプト
#
# LocalStack / Kumo / Floci 上に DynamoDB テーブルを作成する。
# Single-Table Design を採用しており、すべてのエンティティが 1 つのテーブルに格納される。
#
# 使い方:
#   ./scripts/init-dynamodb-tables.sh                          # デフォルト設定
#   TABLE_NAME=MyTable ./scripts/init-dynamodb-tables.sh       # テーブル名を指定
#   ENDPOINT_URL=http://host:4566 ./scripts/init-dynamodb-tables.sh

set -euo pipefail

ENDPOINT_URL="${DYNAMODB_ENDPOINT:-${AWS_ENDPOINT_URL:-http://localhost:4566}}"
TABLE_NAME="${DYNAMODB_TABLE_NAME:-${DYNAMODB_TABLE:-TenkaCloud-dev}}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-ap-northeast-1}}"

export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-test}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-test}"
export AWS_DEFAULT_REGION="$REGION"

aws_cmd() {
  aws --endpoint-url="$ENDPOINT_URL" "$@"
}

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📦 DynamoDB テーブル初期化"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  Endpoint:  $ENDPOINT_URL"
echo "  Table:     $TABLE_NAME"
echo "  Region:    $REGION"
echo ""

# エミュレータの準備を待つ
echo "⏳ エミュレータの準備を確認中..."
MAX_RETRIES=30
RETRY_COUNT=0
until aws_cmd dynamodb list-tables >/dev/null 2>&1; do
  RETRY_COUNT=$((RETRY_COUNT + 1))
  if [ $RETRY_COUNT -ge $MAX_RETRIES ]; then
    echo "❌ エミュレータに接続できません ($ENDPOINT_URL)"
    echo "   make start-localstack または make start-kumo を先に実行してください"
    exit 1
  fi
  sleep 2
  echo "   待機中... ($RETRY_COUNT/$MAX_RETRIES)"
done
echo "✅ エミュレータに接続しました"
echo ""

# ============================================
# メインテーブル作成（Single-Table Design）
# ============================================
#
# エンティティ一覧（PK/SK パターン）:
#   TENANT#{id}     | METADATA             -> テナント情報
#   TENANT#{id}     | USER#{id}            -> テナント-ユーザー所属
#   USER#{id}       | METADATA             -> ユーザー情報
#   EVENT#{id}      | METADATA             -> イベント情報
#   EVENT#{id}      | PROBLEM#{id}         -> イベント-問題マッピング
#   EVENT#{id}      | TEAM#{id}            -> チーム情報
#   EVENT#{id}      | SCORE#{team}#{prob}  -> スコア記録
#   GAMEDAY#{id}    | METADATA             -> GameDay 状態
#   BATTLE#{id}     | METADATA             -> バトル情報
#   BATTLE#{id}     | PARTICIPANT#{id}     -> バトル参加者
#   BATTLE#{id}     | TEAM#{id}            -> バトルチーム
#   BATTLE#{id}     | HISTORY#{id}         -> バトル履歴
#   SCORING#{id}    | METADATA             -> スコアリングセッション
#   CRITERIA#{id}   | METADATA             -> 評価基準
#   DEPLOY#{id}     | METADATA             -> デプロイメント
#   DEPLOY#{id}     | HISTORY#{id}         -> デプロイメント履歴
#   AUDIT#{id}      | METADATA             -> 監査ログ
#   SETTING#{key}   | METADATA             -> システム設定
#   HEALTH#{id}     | METADATA             -> サービスヘルス
#   PROBLEM#{id}    | METADATA             -> 問題テンプレート
#   ATTACK#{id}     | METADATA             -> 攻撃カタログ
#   ALLIANCE#{id}   | METADATA             -> アライアンス
#   VOTE#{id}       | METADATA             -> 投票
#
# GSI:
#   GSI1 (GSI1PK/GSI1SK) - スラッグ・テナント別クエリ
#   GSI2 (EntityType/SK)  - エンティティタイプ別クエリ

echo "📦 テーブル '$TABLE_NAME' を作成中..."

aws_cmd dynamodb create-table \
  --table-name "$TABLE_NAME" \
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
  2>/dev/null && echo "✅ テーブル '$TABLE_NAME' を作成しました" \
  || echo "  テーブル '$TABLE_NAME' は既に存在します"

# テーブル一覧を表示
echo ""
echo "📋 テーブル一覧:"
aws_cmd dynamodb list-tables --output table

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ DynamoDB テーブル初期化が完了しました"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
