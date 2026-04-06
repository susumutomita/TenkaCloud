#!/bin/bash
# GameDay ローカルシードスクリプト
#
# make start 実行後に使用。GameDay サービスにデモデータを投入し、
# すぐにゲームプレイ可能な状態にする。
#
# 使い方:
#   ./scripts/gameday-seed.sh              # デフォルト設定で実行
#   EVENT_ID=my-event ./scripts/gameday-seed.sh  # イベント ID を指定

set -e

GAMEDAY_API="${GAMEDAY_API_URL:-http://localhost:3020/api/gameday}"
EVENT_ID="${EVENT_ID:-local-gameday-001}"
DURATION="${DURATION_MINUTES:-60}"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🎮 GameDay ローカルシード"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  API:       $GAMEDAY_API"
echo "  Event ID:  $EVENT_ID"
echo "  Duration:  ${DURATION} 分"
echo ""

# ヘルスチェック
echo "🔍 GameDay サービスの接続を確認中..."
if ! curl -sf "$GAMEDAY_API/../health" > /dev/null 2>&1; then
  # /health がルートにある場合
  if ! curl -sf "http://localhost:3020/health" > /dev/null 2>&1; then
    echo "❌ GameDay サービスに接続できません (localhost:3020)"
    echo "   make start を先に実行してください"
    exit 1
  fi
fi
echo "✅ GameDay サービスに接続しました"
echo ""

# 1. ゲーム初期化（isRunning: false でゲーム状態を作成）
echo "📦 ステップ 1/5: ゲームを初期化中..."
INIT_RESULT=$(curl -sf -X POST "$GAMEDAY_API/admin/game/init" \
  -H "Content-Type: application/json" \
  -d "{\"eventId\": \"$EVENT_ID\", \"durationMinutes\": $DURATION}" 2>&1) || {
  # 既に初期化済みの場合は続行
  echo "  ⏭️  ゲームは既に初期化されています"
  INIT_RESULT=""
}
if [ -n "$INIT_RESULT" ]; then
  echo "✅ ゲームを初期化しました"
fi

# 2. 攻撃カタログをシード
echo ""
echo "📦 ステップ 2/5: 攻撃カタログをシード中..."
SEED_RESULT=$(curl -sf -X POST "$GAMEDAY_API/admin/attacks/seed" \
  -H "Content-Type: application/json" \
  -d "{\"eventId\": \"$EVENT_ID\"}" 2>&1) || {
  echo "❌ 攻撃カタログのシードに失敗しました"
  echo "   $SEED_RESULT"
  exit 1
}
SEEDED=$(echo "$SEED_RESULT" | grep -o '"seeded":[0-9]*' | grep -o '[0-9]*')
echo "✅ ${SEEDED:-?} 個の攻撃をシードしました"

# 3. チーム登録
echo ""
echo "📦 ステップ 3/5: デモチームを登録中..."

register_team() {
  local team_id="$1"
  local team_name="$2"
  local result
  result=$(curl -sf -X POST "$GAMEDAY_API/admin/teams/register" \
    -H "Content-Type: application/json" \
    -d "{\"eventId\": \"$EVENT_ID\", \"teamId\": \"$team_id\", \"teamName\": \"$team_name\"}" 2>&1)
  local status=$?
  if [ $status -eq 0 ]; then
    echo "  ✅ $team_name ($team_id)"
  else
    # 409 Conflict = already exists
    if echo "$result" | grep -q "既に登録"; then
      echo "  ⏭️  $team_name ($team_id) — 登録済み"
    else
      echo "  ❌ $team_name ($team_id) — $result"
    fi
  fi
}

register_team "team-alpha" "Team Alpha"
register_team "team-bravo" "Team Bravo"
register_team "team-charlie" "Team Charlie"
register_team "team-9" "Team 9"
register_team "red-xiii" "レッドXIII"

# 4. ゲーム開始
echo ""
echo "📦 ステップ 4/5: ゲームを開始中 (${DURATION}分)..."
START_RESULT=$(curl -sf -X POST "$GAMEDAY_API/admin/game/start" \
  -H "Content-Type: application/json" \
  -d "{\"eventId\": \"$EVENT_ID\", \"durationMinutes\": $DURATION}" 2>&1) || {
  # ゲームが既に開始されている場合
  echo "  ⏭️  ゲームは既に開始されています"
  START_RESULT=""
}
if [ -n "$START_RESULT" ]; then
  echo "✅ ゲームを開始しました"
fi

# 5. 状態確認
echo ""
echo "📦 ステップ 5/5: 状態を確認中..."
STATUS=$(curl -sf "$GAMEDAY_API/admin/game/status?eventId=$EVENT_ID" 2>&1)
IS_RUNNING=$(echo "$STATUS" | grep -o '"isRunning":true' || echo "")
if [ -n "$IS_RUNNING" ]; then
  echo "✅ ゲームは実行中です"
else
  echo "⚠️  ゲームの状態を確認できませんでした"
  echo "   $STATUS"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ GameDay のセットアップが完了しました！"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "📋 アクセス先:"
echo "  Application Plane:  http://localhost:13001"
echo "  GameDay 画面:       http://localhost:13001/gameday/$EVENT_ID"
echo "  Admin 画面:         http://localhost:13001/admin/gameday/$EVENT_ID"
echo ""
echo "📋 登録済みチーム:"
echo "  - Team Alpha   (team-alpha)"
echo "  - Team Bravo   (team-bravo)"
echo "  - Team Charlie  (team-charlie)"
echo "  - Team 9       (team-9)"
echo "  - レッドXIII    (red-xiii)"
echo ""
echo "💡 AUTH_SKIP=1 のため、dev-user / dev-tenant として自動ログインされます"
echo ""
