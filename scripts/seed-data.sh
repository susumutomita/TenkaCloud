#!/bin/bash
# DynamoDB シードデータ投入スクリプト
#
# ローカル開発用のデータを DynamoDB テーブルに投入する。
# テーブルが存在しない場合は init-dynamodb-tables.sh を先に実行すること。
#
# 使い方:
#   ./scripts/seed-data.sh                                  # デフォルト設定
#   TABLE_NAME=MyTable ./scripts/seed-data.sh               # テーブル名を指定
#   ENDPOINT_URL=http://host:4566 ./scripts/seed-data.sh    # エンドポイント指定

set -euo pipefail

ENDPOINT_URL="${DYNAMODB_ENDPOINT:-${AWS_ENDPOINT_URL:-http://localhost:4566}}"
TABLE_NAME="${DYNAMODB_TABLE_NAME:-${DYNAMODB_TABLE:-TenkaCloud-dev}}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-ap-northeast-1}}"

export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-test}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-test}"
export AWS_DEFAULT_REGION="$REGION"

NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || python3 -c "from datetime import datetime, timezone; print(datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'))")

aws_cmd() {
  aws --endpoint-url="$ENDPOINT_URL" "$@"
}

put_item() {
  local description="$1"
  shift
  aws_cmd dynamodb put-item --table-name "$TABLE_NAME" "$@" \
    2>/dev/null && echo "  ✅ $description" \
    || echo "  ⏭️  $description（既存またはエラー）"
}

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🌱 シードデータ投入"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  Endpoint:  $ENDPOINT_URL"
echo "  Table:     $TABLE_NAME"
echo "  Region:    $REGION"
echo ""

# テーブル存在確認
if ! aws_cmd dynamodb describe-table --table-name "$TABLE_NAME" >/dev/null 2>&1; then
  echo "❌ テーブル '$TABLE_NAME' が見つかりません"
  echo "   ./scripts/init-dynamodb-tables.sh を先に実行してください"
  exit 1
fi

# ============================================
# 1. テナント（dev-tenant）
# ============================================
echo "📦 テナントをシード中..."

put_item "テナント: dev-tenant" \
  --item '{
    "PK":                {"S": "TENANT#dev-tenant"},
    "SK":                {"S": "METADATA"},
    "GSI1PK":            {"S": "TENANT_SLUG#dev-tenant"},
    "GSI1SK":            {"S": "METADATA"},
    "EntityType":        {"S": "TENANT"},
    "CreatedAt":         {"S": "'"$NOW"'"},
    "UpdatedAt":         {"S": "'"$NOW"'"},
    "id":                {"S": "dev-tenant"},
    "name":              {"S": "開発テナント"},
    "slug":              {"S": "dev-tenant"},
    "status":            {"S": "ACTIVE"},
    "tier":              {"S": "PRO"},
    "adminEmail":        {"S": "admin@dev.tenkacloud.local"},
    "adminName":         {"S": "Dev Admin"},
    "region":            {"S": "ap-northeast-1"},
    "isolationModel":    {"S": "POOL"},
    "computeType":       {"S": "SERVERLESS"},
    "provisioningStatus": {"S": "COMPLETED"}
  }'

# ============================================
# 2. イベント（1 GameDay ACTIVE + 1 Jam SCHEDULED）
# ============================================
echo ""
echo "📦 イベントをシード中..."

GAMEDAY_EVENT_ID="evt-gameday-local-001"
JAM_EVENT_ID="evt-jam-local-001"
GAMEDAY_START="2026-04-01T09:00:00Z"
GAMEDAY_END="2026-12-31T18:00:00Z"
JAM_START="2026-05-01T09:00:00Z"
JAM_END="2026-05-02T18:00:00Z"

# GameDay イベント（ACTIVE）
put_item "イベント: GameDay (ACTIVE)" \
  --item '{
    "PK":                      {"S": "EVENT#'"$GAMEDAY_EVENT_ID"'"},
    "SK":                      {"S": "METADATA"},
    "GSI1PK":                  {"S": "TENANT#dev-tenant"},
    "GSI1SK":                  {"S": "'"$GAMEDAY_START"'"},
    "EntityType":              {"S": "EVENT"},
    "CreatedAt":               {"S": "'"$NOW"'"},
    "UpdatedAt":               {"S": "'"$NOW"'"},
    "id":                      {"S": "'"$GAMEDAY_EVENT_ID"'"},
    "externalId":              {"S": "gameday-local-001"},
    "tenantId":                {"S": "dev-tenant"},
    "name":                    {"S": "TenkaCloud ローカル GameDay 2026"},
    "type":                    {"S": "GAMEDAY"},
    "status":                  {"S": "ACTIVE"},
    "startTime":               {"S": "'"$GAMEDAY_START"'"},
    "endTime":                 {"S": "'"$GAMEDAY_END"'"},
    "timezone":                {"S": "Asia/Tokyo"},
    "participantType":         {"S": "TEAM"},
    "maxParticipants":         {"N": "20"},
    "minTeamSize":             {"N": "2"},
    "maxTeamSize":             {"N": "4"},
    "cloudProvider":           {"S": "AWS"},
    "regions":                 {"L": [{"S": "ap-northeast-1"}]},
    "scoringType":             {"S": "REALTIME"},
    "scoringIntervalMinutes":  {"N": "5"},
    "leaderboardVisible":      {"BOOL": true},
    "createdBy":               {"S": "seed-script"}
  }'

# GameDay 状態
put_item "GameDay 状態: $GAMEDAY_EVENT_ID" \
  --item '{
    "PK":              {"S": "GAMEDAY#'"$GAMEDAY_EVENT_ID"'"},
    "SK":              {"S": "METADATA"},
    "GSI1PK":          {"S": "TENANT#dev-tenant#GAMEDAY"},
    "GSI1SK":          {"S": "'"$GAMEDAY_START"'"},
    "EntityType":      {"S": "GAMEDAY"},
    "CreatedAt":       {"S": "'"$NOW"'"},
    "UpdatedAt":       {"S": "'"$NOW"'"},
    "eventId":         {"S": "'"$GAMEDAY_EVENT_ID"'"},
    "tenantId":        {"S": "dev-tenant"},
    "isRunning":       {"BOOL": false},
    "startedAt":       {"NULL": true},
    "scoreWeight":     {"S": "normal"},
    "blackout":        {"BOOL": false},
    "durationMinutes": {"N": "120"}
  }'

# Jam イベント（SCHEDULED）
put_item "イベント: Jam (SCHEDULED)" \
  --item '{
    "PK":                      {"S": "EVENT#'"$JAM_EVENT_ID"'"},
    "SK":                      {"S": "METADATA"},
    "GSI1PK":                  {"S": "TENANT#dev-tenant"},
    "GSI1SK":                  {"S": "'"$JAM_START"'"},
    "EntityType":              {"S": "EVENT"},
    "CreatedAt":               {"S": "'"$NOW"'"},
    "UpdatedAt":               {"S": "'"$NOW"'"},
    "id":                      {"S": "'"$JAM_EVENT_ID"'"},
    "externalId":              {"S": "jam-local-001"},
    "tenantId":                {"S": "dev-tenant"},
    "name":                    {"S": "TenkaCloud ローカル Jam 2026"},
    "type":                    {"S": "JAM"},
    "status":                  {"S": "SCHEDULED"},
    "startTime":               {"S": "'"$JAM_START"'"},
    "endTime":                 {"S": "'"$JAM_END"'"},
    "timezone":                {"S": "Asia/Tokyo"},
    "participantType":         {"S": "INDIVIDUAL"},
    "maxParticipants":         {"N": "50"},
    "cloudProvider":           {"S": "AWS"},
    "regions":                 {"L": [{"S": "ap-northeast-1"}]},
    "scoringType":             {"S": "BATCH"},
    "scoringIntervalMinutes":  {"N": "10"},
    "leaderboardVisible":      {"BOOL": true},
    "createdBy":               {"S": "seed-script"}
  }'

# ============================================
# 3. 問題テンプレート（5 問: 難易度・カテゴリ混合）
# ============================================
echo ""
echo "📦 問題テンプレートをシード中..."

put_item "問題: S3 バケットポリシー (EASY/SECURITY)" \
  --item '{
    "PK":                  {"S": "PROBLEM#prob-001"},
    "SK":                  {"S": "METADATA"},
    "GSI1PK":              {"S": "PROBLEM_CATEGORY#SECURITY"},
    "GSI1SK":              {"S": "EASY#prob-001"},
    "EntityType":          {"S": "PROBLEM_TEMPLATE"},
    "CreatedAt":           {"S": "'"$NOW"'"},
    "UpdatedAt":           {"S": "'"$NOW"'"},
    "id":                  {"S": "prob-001"},
    "name":                {"S": "S3 バケットポリシーの修正"},
    "description":         {"S": "パブリックアクセスが有効な S3 バケットのセキュリティを強化する"},
    "type":                {"S": "GAMEDAY"},
    "category":            {"S": "SECURITY"},
    "difficulty":          {"S": "EASY"},
    "status":              {"S": "PUBLISHED"},
    "variables":           {"L": []},
    "overviewTemplate":    {"S": "S3 バケットのパブリックアクセスを無効化し、適切なバケットポリシーを設定してください。"},
    "objectivesTemplate":  {"L": [{"S": "パブリックアクセスをブロック"}, {"S": "バケットポリシーを設定"}]},
    "hintsTemplate":       {"L": [{"S": "aws s3api put-public-access-block を使用"}]},
    "prerequisites":       {"L": [{"S": "AWS CLI"}]},
    "estimatedTimeMinutes": {"N": "15"},
    "providers":           {"L": [{"S": "AWS"}]},
    "templateType":        {"S": "CLOUDFORMATION"},
    "templateContent":     {"S": "---"},
    "regions":             {"M": {"AWS": {"L": [{"S": "ap-northeast-1"}]}}},
    "deploymentTimeout":   {"N": "300"},
    "scoringType":         {"S": "LAMBDA"},
    "criteriaTemplate":    {"L": []},
    "scoringTimeout":      {"N": "60"},
    "tags":                {"L": [{"S": "s3"}, {"S": "security"}]},
    "author":              {"S": "tenkacloud"},
    "version":             {"S": "1.0.0"},
    "usageCount":          {"N": "0"}
  }'

put_item "問題: VPC ネットワーク設計 (MEDIUM/ARCHITECTURE)" \
  --item '{
    "PK":                  {"S": "PROBLEM#prob-002"},
    "SK":                  {"S": "METADATA"},
    "GSI1PK":              {"S": "PROBLEM_CATEGORY#ARCHITECTURE"},
    "GSI1SK":              {"S": "MEDIUM#prob-002"},
    "EntityType":          {"S": "PROBLEM_TEMPLATE"},
    "CreatedAt":           {"S": "'"$NOW"'"},
    "UpdatedAt":           {"S": "'"$NOW"'"},
    "id":                  {"S": "prob-002"},
    "name":                {"S": "VPC ネットワーク設計"},
    "description":         {"S": "マルチ AZ 対応の VPC を設計し、パブリック/プライベートサブネットを構成する"},
    "type":                {"S": "GAMEDAY"},
    "category":            {"S": "ARCHITECTURE"},
    "difficulty":          {"S": "MEDIUM"},
    "status":              {"S": "PUBLISHED"},
    "variables":           {"L": []},
    "overviewTemplate":    {"S": "3 つの AZ にまたがる VPC を作成し、適切なルーティングを構成してください。"},
    "objectivesTemplate":  {"L": [{"S": "VPC を作成"}, {"S": "サブネットを構成"}, {"S": "NAT Gateway を設置"}]},
    "hintsTemplate":       {"L": [{"S": "CIDR 設計を事前に検討"}]},
    "prerequisites":       {"L": [{"S": "AWS CLI"}, {"S": "VPC の基本知識"}]},
    "estimatedTimeMinutes": {"N": "30"},
    "providers":           {"L": [{"S": "AWS"}]},
    "templateType":        {"S": "CLOUDFORMATION"},
    "templateContent":     {"S": "---"},
    "regions":             {"M": {"AWS": {"L": [{"S": "ap-northeast-1"}]}}},
    "deploymentTimeout":   {"N": "600"},
    "scoringType":         {"S": "LAMBDA"},
    "criteriaTemplate":    {"L": []},
    "scoringTimeout":      {"N": "60"},
    "tags":                {"L": [{"S": "vpc"}, {"S": "networking"}]},
    "author":              {"S": "tenkacloud"},
    "version":             {"S": "1.0.0"},
    "usageCount":          {"N": "0"}
  }'

put_item "問題: Lambda コスト最適化 (MEDIUM/COST)" \
  --item '{
    "PK":                  {"S": "PROBLEM#prob-003"},
    "SK":                  {"S": "METADATA"},
    "GSI1PK":              {"S": "PROBLEM_CATEGORY#COST"},
    "GSI1SK":              {"S": "MEDIUM#prob-003"},
    "EntityType":          {"S": "PROBLEM_TEMPLATE"},
    "CreatedAt":           {"S": "'"$NOW"'"},
    "UpdatedAt":           {"S": "'"$NOW"'"},
    "id":                  {"S": "prob-003"},
    "name":                {"S": "Lambda コスト最適化"},
    "description":         {"S": "過剰なメモリ・タイムアウト設定の Lambda 関数を最適化する"},
    "type":                {"S": "GAMEDAY"},
    "category":            {"S": "COST"},
    "difficulty":          {"S": "MEDIUM"},
    "status":              {"S": "PUBLISHED"},
    "variables":           {"L": []},
    "overviewTemplate":    {"S": "Lambda 関数のメモリとタイムアウトを適切に設定し、コストを削減してください。"},
    "objectivesTemplate":  {"L": [{"S": "メモリ設定を最適化"}, {"S": "タイムアウトを調整"}]},
    "hintsTemplate":       {"L": [{"S": "AWS Lambda Power Tuning ツールを参考に"}]},
    "prerequisites":       {"L": [{"S": "AWS CLI"}, {"S": "Lambda の基本知識"}]},
    "estimatedTimeMinutes": {"N": "20"},
    "providers":           {"L": [{"S": "AWS"}]},
    "templateType":        {"S": "SAM"},
    "templateContent":     {"S": "---"},
    "regions":             {"M": {"AWS": {"L": [{"S": "ap-northeast-1"}]}}},
    "deploymentTimeout":   {"N": "300"},
    "scoringType":         {"S": "LAMBDA"},
    "criteriaTemplate":    {"L": []},
    "scoringTimeout":      {"N": "60"},
    "tags":                {"L": [{"S": "lambda"}, {"S": "cost"}]},
    "author":              {"S": "tenkacloud"},
    "version":             {"S": "1.0.0"},
    "usageCount":          {"N": "0"}
  }'

put_item "問題: RDS マルチ AZ フェイルオーバー (HARD/RELIABILITY)" \
  --item '{
    "PK":                  {"S": "PROBLEM#prob-004"},
    "SK":                  {"S": "METADATA"},
    "GSI1PK":              {"S": "PROBLEM_CATEGORY#RELIABILITY"},
    "GSI1SK":              {"S": "HARD#prob-004"},
    "EntityType":          {"S": "PROBLEM_TEMPLATE"},
    "CreatedAt":           {"S": "'"$NOW"'"},
    "UpdatedAt":           {"S": "'"$NOW"'"},
    "id":                  {"S": "prob-004"},
    "name":                {"S": "RDS マルチ AZ フェイルオーバー"},
    "description":         {"S": "RDS マルチ AZ 構成を構築し、フェイルオーバーテストを実施する"},
    "type":                {"S": "GAMEDAY"},
    "category":            {"S": "RELIABILITY"},
    "difficulty":          {"S": "HARD"},
    "status":              {"S": "PUBLISHED"},
    "variables":           {"L": []},
    "overviewTemplate":    {"S": "RDS をマルチ AZ 構成にし、手動フェイルオーバーで正常動作を確認してください。"},
    "objectivesTemplate":  {"L": [{"S": "マルチ AZ を有効化"}, {"S": "フェイルオーバーを実行"}, {"S": "復旧を確認"}]},
    "hintsTemplate":       {"L": [{"S": "rds reboot-db-instance --force-failover"}]},
    "prerequisites":       {"L": [{"S": "AWS CLI"}, {"S": "RDS の基本知識"}]},
    "estimatedTimeMinutes": {"N": "45"},
    "providers":           {"L": [{"S": "AWS"}]},
    "templateType":        {"S": "CLOUDFORMATION"},
    "templateContent":     {"S": "---"},
    "regions":             {"M": {"AWS": {"L": [{"S": "ap-northeast-1"}]}}},
    "deploymentTimeout":   {"N": "900"},
    "scoringType":         {"S": "LAMBDA"},
    "criteriaTemplate":    {"L": []},
    "scoringTimeout":      {"N": "120"},
    "tags":                {"L": [{"S": "rds"}, {"S": "ha"}, {"S": "failover"}]},
    "author":              {"S": "tenkacloud"},
    "version":             {"S": "1.0.0"},
    "usageCount":          {"N": "0"}
  }'

put_item "問題: CloudWatch アラーム設計 (EASY/OPERATIONS)" \
  --item '{
    "PK":                  {"S": "PROBLEM#prob-005"},
    "SK":                  {"S": "METADATA"},
    "GSI1PK":              {"S": "PROBLEM_CATEGORY#OPERATIONS"},
    "GSI1SK":              {"S": "EASY#prob-005"},
    "EntityType":          {"S": "PROBLEM_TEMPLATE"},
    "CreatedAt":           {"S": "'"$NOW"'"},
    "UpdatedAt":           {"S": "'"$NOW"'"},
    "id":                  {"S": "prob-005"},
    "name":                {"S": "CloudWatch アラーム設計"},
    "description":         {"S": "EC2 インスタンスの CPU 使用率監視アラームを設定する"},
    "type":                {"S": "JAM"},
    "category":            {"S": "OPERATIONS"},
    "difficulty":          {"S": "EASY"},
    "status":              {"S": "PUBLISHED"},
    "variables":           {"L": []},
    "overviewTemplate":    {"S": "EC2 インスタンスに適切な CloudWatch アラームを設定してください。"},
    "objectivesTemplate":  {"L": [{"S": "CPU アラームを作成"}, {"S": "SNS 通知を設定"}]},
    "hintsTemplate":       {"L": [{"S": "cloudwatch put-metric-alarm を使用"}]},
    "prerequisites":       {"L": [{"S": "AWS CLI"}]},
    "estimatedTimeMinutes": {"N": "15"},
    "providers":           {"L": [{"S": "AWS"}]},
    "templateType":        {"S": "CLOUDFORMATION"},
    "templateContent":     {"S": "---"},
    "regions":             {"M": {"AWS": {"L": [{"S": "ap-northeast-1"}]}}},
    "deploymentTimeout":   {"N": "300"},
    "scoringType":         {"S": "LAMBDA"},
    "criteriaTemplate":    {"L": []},
    "scoringTimeout":      {"N": "60"},
    "tags":                {"L": [{"S": "monitoring"}, {"S": "cloudwatch"}]},
    "author":              {"S": "tenkacloud"},
    "version":             {"S": "1.0.0"},
    "usageCount":          {"N": "0"}
  }'

# イベントに問題を紐付け
echo ""
echo "📦 イベントと問題の紐付けをシード中..."

for i in 1 2 3 4 5; do
  PROB_ID="prob-00$i"
  put_item "イベント問題: $GAMEDAY_EVENT_ID - $PROB_ID" \
    --item '{
      "PK":                {"S": "EVENT#'"$GAMEDAY_EVENT_ID"'"},
      "SK":                {"S": "PROBLEM#'"$PROB_ID"'"},
      "GSI1PK":            {"S": "PROBLEM#'"$PROB_ID"'"},
      "GSI1SK":            {"S": "EVENT#'"$GAMEDAY_EVENT_ID"'"},
      "EntityType":        {"S": "EVENT_PROBLEM"},
      "CreatedAt":         {"S": "'"$NOW"'"},
      "UpdatedAt":         {"S": "'"$NOW"'"},
      "eventId":           {"S": "'"$GAMEDAY_EVENT_ID"'"},
      "problemId":         {"S": "'"$PROB_ID"'"},
      "order":             {"N": "'"$i"'"},
      "pointMultiplier":   {"N": "1"}
    }'
done

# ============================================
# 4. チーム（3 チーム）
# ============================================
echo ""
echo "📦 チームをシード中..."

put_item "チーム: Team Alpha" \
  --item '{
    "PK":            {"S": "EVENT#'"$GAMEDAY_EVENT_ID"'"},
    "SK":            {"S": "TEAM#team-alpha"},
    "GSI1PK":        {"S": "TEAM#team-alpha"},
    "GSI1SK":        {"S": "EVENT#'"$GAMEDAY_EVENT_ID"'"},
    "EntityType":    {"S": "TEAM"},
    "CreatedAt":     {"S": "'"$NOW"'"},
    "UpdatedAt":     {"S": "'"$NOW"'"},
    "teamId":        {"S": "team-alpha"},
    "teamName":      {"S": "Team Alpha"},
    "eventId":       {"S": "'"$GAMEDAY_EVENT_ID"'"},
    "score":         {"N": "0"}
  }'

put_item "チーム: Team Bravo" \
  --item '{
    "PK":            {"S": "EVENT#'"$GAMEDAY_EVENT_ID"'"},
    "SK":            {"S": "TEAM#team-bravo"},
    "GSI1PK":        {"S": "TEAM#team-bravo"},
    "GSI1SK":        {"S": "EVENT#'"$GAMEDAY_EVENT_ID"'"},
    "EntityType":    {"S": "TEAM"},
    "CreatedAt":     {"S": "'"$NOW"'"},
    "UpdatedAt":     {"S": "'"$NOW"'"},
    "teamId":        {"S": "team-bravo"},
    "teamName":      {"S": "Team Bravo"},
    "eventId":       {"S": "'"$GAMEDAY_EVENT_ID"'"},
    "score":         {"N": "0"}
  }'

put_item "チーム: Team Charlie" \
  --item '{
    "PK":            {"S": "EVENT#'"$GAMEDAY_EVENT_ID"'"},
    "SK":            {"S": "TEAM#team-charlie"},
    "GSI1PK":        {"S": "TEAM#team-charlie"},
    "GSI1SK":        {"S": "EVENT#'"$GAMEDAY_EVENT_ID"'"},
    "EntityType":    {"S": "TEAM"},
    "CreatedAt":     {"S": "'"$NOW"'"},
    "UpdatedAt":     {"S": "'"$NOW"'"},
    "teamId":        {"S": "team-charlie"},
    "teamName":      {"S": "Team Charlie"},
    "eventId":       {"S": "'"$GAMEDAY_EVENT_ID"'"},
    "score":         {"N": "0"}
  }'

# ============================================
# 5. 攻撃カタログ
# ============================================
echo ""
echo "📦 攻撃カタログをシード中..."

put_item "攻撃: EC2 インスタンス停止" \
  --item '{
    "PK":            {"S": "ATTACK#atk-001"},
    "SK":            {"S": "METADATA"},
    "GSI1PK":        {"S": "ATTACK_CATALOG"},
    "GSI1SK":        {"S": "EASY#atk-001"},
    "EntityType":    {"S": "ATTACK"},
    "CreatedAt":     {"S": "'"$NOW"'"},
    "UpdatedAt":     {"S": "'"$NOW"'"},
    "id":            {"S": "atk-001"},
    "name":          {"S": "EC2 インスタンス停止"},
    "description":   {"S": "ランダムな EC2 インスタンスを停止する"},
    "severity":      {"S": "MEDIUM"},
    "category":      {"S": "COMPUTE"},
    "cooldownMinutes": {"N": "5"}
  }'

put_item "攻撃: セキュリティグループ開放" \
  --item '{
    "PK":            {"S": "ATTACK#atk-002"},
    "SK":            {"S": "METADATA"},
    "GSI1PK":        {"S": "ATTACK_CATALOG"},
    "GSI1SK":        {"S": "MEDIUM#atk-002"},
    "EntityType":    {"S": "ATTACK"},
    "CreatedAt":     {"S": "'"$NOW"'"},
    "UpdatedAt":     {"S": "'"$NOW"'"},
    "id":            {"S": "atk-002"},
    "name":          {"S": "セキュリティグループ開放"},
    "description":   {"S": "セキュリティグループに全ポート開放ルールを追加する"},
    "severity":      {"S": "HIGH"},
    "category":      {"S": "SECURITY"},
    "cooldownMinutes": {"N": "10"}
  }'

put_item "攻撃: S3 バケット公開" \
  --item '{
    "PK":            {"S": "ATTACK#atk-003"},
    "SK":            {"S": "METADATA"},
    "GSI1PK":        {"S": "ATTACK_CATALOG"},
    "GSI1SK":        {"S": "HARD#atk-003"},
    "EntityType":    {"S": "ATTACK"},
    "CreatedAt":     {"S": "'"$NOW"'"},
    "UpdatedAt":     {"S": "'"$NOW"'"},
    "id":            {"S": "atk-003"},
    "name":          {"S": "S3 バケット公開"},
    "description":   {"S": "S3 バケットのパブリックアクセスブロックを無効化する"},
    "severity":      {"S": "CRITICAL"},
    "category":      {"S": "STORAGE"},
    "cooldownMinutes": {"N": "15"}
  }'

put_item "攻撃: RDS スナップショット削除" \
  --item '{
    "PK":            {"S": "ATTACK#atk-004"},
    "SK":            {"S": "METADATA"},
    "GSI1PK":        {"S": "ATTACK_CATALOG"},
    "GSI1SK":        {"S": "HARD#atk-004"},
    "EntityType":    {"S": "ATTACK"},
    "CreatedAt":     {"S": "'"$NOW"'"},
    "UpdatedAt":     {"S": "'"$NOW"'"},
    "id":            {"S": "atk-004"},
    "name":          {"S": "RDS スナップショット削除"},
    "description":   {"S": "RDS の自動バックアップスナップショットを削除する"},
    "severity":      {"S": "CRITICAL"},
    "category":      {"S": "DATABASE"},
    "cooldownMinutes": {"N": "15"}
  }'

put_item "攻撃: Lambda 同時実行制限" \
  --item '{
    "PK":            {"S": "ATTACK#atk-005"},
    "SK":            {"S": "METADATA"},
    "GSI1PK":        {"S": "ATTACK_CATALOG"},
    "GSI1SK":        {"S": "MEDIUM#atk-005"},
    "EntityType":    {"S": "ATTACK"},
    "CreatedAt":     {"S": "'"$NOW"'"},
    "UpdatedAt":     {"S": "'"$NOW"'"},
    "id":            {"S": "atk-005"},
    "name":          {"S": "Lambda 同時実行制限"},
    "description":   {"S": "Lambda 関数の同時実行数を 1 に制限する"},
    "severity":      {"S": "HIGH"},
    "category":      {"S": "COMPUTE"},
    "cooldownMinutes": {"N": "10"}
  }'

# ============================================
# 完了サマリ
# ============================================
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ シードデータの投入が完了しました"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "📋 投入データ:"
echo "  - テナント: 1 (dev-tenant)"
echo "  - イベント: 2 (GameDay ACTIVE + Jam SCHEDULED)"
echo "  - 問題テンプレート: 5 (SECURITY/ARCHITECTURE/COST/RELIABILITY/OPERATIONS)"
echo "  - チーム: 3 (Alpha, Bravo, Charlie)"
echo "  - 攻撃カタログ: 5"
echo ""
echo "📋 アクセス先:"
echo "  Application Plane:  http://localhost:13001"
echo "  GameDay 画面:       http://localhost:13001/gameday/$GAMEDAY_EVENT_ID"
echo ""
