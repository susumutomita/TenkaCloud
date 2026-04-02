#!/bin/bash
# PostToolUse Hook: ファイル編集後に自動フォーマット
#
# Write/Edit/MultiEdit 後に実行され、Prettier で自動整形する。
# 違反があれば hookSpecificOutput.additionalContext で返し、
# エージェントが次のアクションで自動修正する。

set -e

# tool_input から編集されたファイルパスを取得
FILE_PATH=$(echo "$TOOL_INPUT" | jq -r '.file_path // empty')
if [ -z "$FILE_PATH" ]; then
  exit 0
fi

# 対象拡張子のみ処理
case "$FILE_PATH" in
  *.ts|*.tsx|*.js|*.jsx|*.css|*.json)
    ;;
  *)
    exit 0
    ;;
esac

# ファイルが存在しない場合はスキップ
if [ ! -f "$FILE_PATH" ]; then
  exit 0
fi

# Prettier でフォーマット（bunx を使用）
BUN="${HOME}/.local/share/mise/installs/bun/1.2.20/bin/bun"
if [ ! -x "$BUN" ]; then
  BUN="bun"
fi

FORMAT_OUTPUT=$("$BUN" x prettier --write "$FILE_PATH" 2>&1) || true

# フォーマット変更があったかチェック
if git diff --quiet "$FILE_PATH" 2>/dev/null; then
  exit 0
fi

# 変更があった場合、エージェントにフィードバック
echo "{\"hookSpecificOutput\":{\"additionalContext\":\"Auto-formatted $FILE_PATH with Prettier.\"}}"
