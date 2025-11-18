#!/bin/bash
# 提案承認スクリプト
# pending-suggestions.json の提案をインタラクティブに承認/拒否

set -euo pipefail

# プロジェクトルートを取得
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
CLAUDE_DIR="$PROJECT_ROOT/.claude"
SUGGESTIONS_FILE="$CLAUDE_DIR/pending-suggestions.json"

# 提案ファイルの存在確認
if [ ! -f "$SUGGESTIONS_FILE" ]; then
  echo "提案ファイルが見つかりません: $SUGGESTIONS_FILE" >&2
  echo "先に suggest-claude-md-hook.sh を実行してください。" >&2
  exit 1
fi

# 提案を読み込み
SUGGESTIONS=$(cat "$SUGGESTIONS_FILE")
SUGGESTION_COUNT=$(echo "$SUGGESTIONS" | jq 'length')

if [ "$SUGGESTION_COUNT" -eq 0 ]; then
  echo "承認待ちの提案はありません。"
  exit 0
fi

echo "=========================================="
echo "📋 承認待ちの提案: ${SUGGESTION_COUNT} 件"
echo "=========================================="
echo ""

# 各提案を処理
APPROVED=0
SKIPPED=0
SAVED_FOR_LATER=0

for i in $(seq 0 $((SUGGESTION_COUNT - 1))); do
  SUGGESTION=$(echo "$SUGGESTIONS" | jq ".[$i]")
  CATEGORY=$(echo "$SUGGESTION" | jq -r '.category')
  TARGET_FILE=$(echo "$SUGGESTION" | jq -r '.target_file')
  CONTENT=$(echo "$SUGGESTION" | jq -r '.content')
  TIMESTAMP=$(echo "$SUGGESTION" | jq -r '.timestamp')

  echo "=========================================="
  echo "提案 $((i + 1))/${SUGGESTION_COUNT}"
  echo "カテゴリ: $CATEGORY"
  echo "対象ファイル: $TARGET_FILE"
  echo "タイムスタンプ: $TIMESTAMP"
  echo "=========================================="
  echo ""
  echo "$CONTENT"
  echo ""
  echo "=========================================="
  echo ""

  # ユーザー入力を待つ
  while true; do
    read -p "この提案を適用しますか？ (y: 適用 / n: スキップ / s: 後で / q: 終了): " -n 1 -r
    echo ""

    case $REPLY in
      y|Y)
        # 提案を適用
        if [ ! -f "$TARGET_FILE" ]; then
          # ファイルが存在しない場合は新規作成
          mkdir -p "$(dirname "$TARGET_FILE")"
          echo "$CONTENT" > "$TARGET_FILE"
          echo "✅ 新規作成しました: $TARGET_FILE"
        else
          # 既存ファイルに追記
          {
            echo ""
            echo "<!-- Added by Repository Hooks ($TIMESTAMP) -->"
            echo ""
            echo "$CONTENT"
          } >> "$TARGET_FILE"
          echo "✅ 追記しました: $TARGET_FILE"
        fi
        APPROVED=$((APPROVED + 1))
        break
        ;;
      n|N)
        echo "⏭️ スキップしました"
        SKIPPED=$((SKIPPED + 1))
        break
        ;;
      s|S)
        # HTMLコメントとして保存
        if [ -f "$TARGET_FILE" ]; then
          {
            echo ""
            echo "<!-- SUGGESTED by Repository Hooks ($TIMESTAMP)"
            echo "     Category: $CATEGORY"
            echo "     Review and uncomment if you agree, or delete if not useful -->"
            echo "<!--"
            echo "$CONTENT"
            echo "-->"
          } >> "$TARGET_FILE"
          echo "💾 コメントとして保存しました: $TARGET_FILE"
        else
          mkdir -p "$(dirname "$TARGET_FILE")"
          {
            echo "<!-- SUGGESTED by Repository Hooks ($TIMESTAMP)"
            echo "     Category: $CATEGORY"
            echo "     Review and uncomment if you agree, or delete if not useful -->"
            echo "<!--"
            echo "$CONTENT"
            echo "-->"
          } > "$TARGET_FILE"
          echo "💾 コメントとして新規作成しました: $TARGET_FILE"
        fi
        SAVED_FOR_LATER=$((SAVED_FOR_LATER + 1))
        break
        ;;
      q|Q)
        echo ""
        echo "終了します。残りの提案は次回実行時に確認できます。"
        echo ""
        echo "結果: 適用 $APPROVED 件 / スキップ $SKIPPED 件 / 後で $SAVED_FOR_LATER 件"
        exit 0
        ;;
      *)
        echo "y/n/s/q のいずれかを入力してください"
        ;;
    esac
  done
  echo ""
done

# 完了メッセージ
echo "=========================================="
echo "✅ すべての提案を処理しました"
echo ""
echo "結果:"
echo "  適用: $APPROVED 件"
echo "  スキップ: $SKIPPED 件"
echo "  後で: $SAVED_FOR_LATER 件"
echo "=========================================="

# 提案ファイルを削除（すべて処理済み）
if [ $((APPROVED + SKIPPED + SAVED_FOR_LATER)) -eq "$SUGGESTION_COUNT" ]; then
  mv "$SUGGESTIONS_FILE" "$SUGGESTIONS_FILE.processed.$(date +%Y%m%d-%H%M%S)"
  echo ""
  echo "提案ファイルをアーカイブしました。"
fi
