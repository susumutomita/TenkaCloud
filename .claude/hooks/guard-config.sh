#!/bin/bash
# PreToolUse Hook: 設定ファイルの直接編集をブロック
#
# エージェントが linter/formatter/test の設定ファイルを編集しようとした場合、
# exit code 2 でブロックし、コードを修正するよう指示する。

FILE_PATH=$(echo "$TOOL_INPUT" | jq -r '.file_path // empty')
if [ -z "$FILE_PATH" ]; then
  exit 0
fi

BASENAME=$(basename "$FILE_PATH")

# ブロック対象の設定ファイル
case "$BASENAME" in
  .eslintrc*|eslint.config.*|biome.json|.prettierrc*|prettier.config.*)
    echo "BLOCKED: $BASENAME の編集は禁止されています。" >&2
    echo "WHY: 設定を緩めるのではなく、コードを修正してください。" >&2
    echo "FIX: lint/format エラーが出ている場合は、ソースコードを修正してください。" >&2
    exit 2
    ;;
  vitest.config.*|jest.config.*)
    echo "BLOCKED: $BASENAME の編集は禁止されています。" >&2
    echo "WHY: テスト設定の変更はカバレッジ基準を下げるリスクがあります。" >&2
    echo "FIX: テストコードを追加・修正してカバレッジを満たしてください。" >&2
    exit 2
    ;;
  .env|.env.local|.env.production|.env.development)
    echo "BLOCKED: $BASENAME にはシークレットが含まれる可能性があります。" >&2
    echo "WHY: セキュリティ保護のため、環境変数ファイルの直接編集を禁止しています。" >&2
    echo "FIX: .env.example を更新し、ユーザーに .env.local の手動設定を指示してください。" >&2
    exit 2
    ;;
esac

exit 0
