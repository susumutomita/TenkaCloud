#!/usr/bin/env bash
# AWS 一時クレデンシャルをシェル環境にエクスポートするヘルパースクリプト
#
# 使い方: source scripts/aws-creds.sh
#
# ~/.aws/login/cache から一時クレデンシャルを読み取り、
# AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN を設定する。

set -euo pipefail

CACHE_DIR="$HOME/.aws/login/cache"

if [ ! -d "$CACHE_DIR" ]; then
  echo "❌ AWS ログインキャッシュが見つかりません: $CACHE_DIR" >&2
  echo "   先に AWS コンソールにログインしてください。" >&2
  return 1 2>/dev/null || exit 1
fi

CREDS=$(python3 - <<'EOF'
import json, os, sys
from datetime import datetime, timezone

cache_dir = os.path.expanduser("~/.aws/login/cache")
for fname in os.listdir(cache_dir):
    try:
        with open(os.path.join(cache_dir, fname)) as f:
            data = json.load(f)
        t = data.get("accessToken", {})
        if not isinstance(t, dict) or "accessKeyId" not in t:
            continue
        exp = datetime.fromisoformat(t["expiresAt"].replace("Z", "+00:00"))
        remaining = (exp - datetime.now(timezone.utc)).total_seconds()
        if remaining <= 0:
            print(f"EXPIRED:{t['expiresAt']}", file=sys.stderr)
            sys.exit(1)
        print(f"export AWS_ACCESS_KEY_ID={t['accessKeyId']}")
        print(f"export AWS_SECRET_ACCESS_KEY={t['secretAccessKey']}")
        print(f"export AWS_SESSION_TOKEN={t['sessionToken']}")
        print(f"export AWS_REGION=ap-northeast-1")
        mins = int(remaining // 60)
        print(f"# 有効期限: {t['expiresAt']} (残り約 {mins} 分)", file=sys.stderr)
        sys.exit(0)
    except Exception:
        continue
print("クレデンシャルが見つかりません", file=sys.stderr)
sys.exit(1)
EOF
) || {
  echo "❌ クレデンシャルの取得に失敗しました。再ログインしてください。" >&2
  return 1 2>/dev/null || exit 1
}

eval "$CREDS"
echo "✅ AWS クレデンシャルをエクスポートしました (account: ${AWS_ACCOUNT_ID:-$(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo 'unknown')})"
