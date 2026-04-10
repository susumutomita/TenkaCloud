#!/bin/bash
# PostToolUse Hook: 編集直後に危険な一時しのぎをブロック

set -euo pipefail

FILE_PATH=$(echo "$TOOL_INPUT" | jq -r '.file_path // empty')
if [ -z "$FILE_PATH" ] || [ ! -f "$FILE_PATH" ]; then
  exit 0
fi

case "$FILE_PATH" in
  *.ts|*.tsx|*.js|*.jsx)
    ;;
  *)
    exit 0
    ;;
esac

if [[ "$FILE_PATH" == *"/__tests__/"* ]] || [[ "$FILE_PATH" == *".test."* ]] || [[ "$FILE_PATH" == *".spec."* ]]; then
  exit 0
fi

CONTENT=$(cat "$FILE_PATH")

if echo "$CONTENT" | grep -Eqi 'fallback to empty|empty dataset|empty values|stub problem|returning empty'; then
  echo "BLOCKED: 一時しのぎの fallback / stub が検出されました: $FILE_PATH" >&2
  echo "FIX: 空データで握り潰さず、正しい service fallback を実装するか明示的に失敗させてください。" >&2
  exit 2
fi

if [[ "$FILE_PATH" =~ (^|/)apps/(application-plane|control-plane)/app/ ]] && [[ "$FILE_PATH" != *"/app/api/"* ]]; then
  if echo "$CONTENT" | grep -Eq '\bfetch\s*\('; then
    echo "BLOCKED: UI レイヤーの直接 fetch が検出されました: $FILE_PATH" >&2
    echo "FIX: lib/api または server helper 経由に寄せてください。" >&2
    exit 2
  fi

  if echo "$CONTENT" | grep -Eq 'process\.env\.(NEXT_PUBLIC_[A-Z0-9_]*API_URL|[A-Z0-9_]*API_URL)'; then
    echo "BLOCKED: UI レイヤーの直接 API_URL 参照が検出されました: $FILE_PATH" >&2
    echo "FIX: API URL 解決は helper に閉じ込めてください。" >&2
    exit 2
  fi
fi

exit 0
