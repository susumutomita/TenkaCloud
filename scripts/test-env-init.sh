#!/usr/bin/env bash
# Issue #1345: shell-level integration test for `scripts/env-init.ts`.
#
# vitest 側 (= infrastructure/test/scripts/env-init.test.ts) で純粋 logic は
# pin している。 本 shell test は CLI entry (= `bun run scripts/env-init.ts`) を
# 一時 work dir で叩き、
#   1. 非対話 (= 非 TTY) 経路で .env が生成される
#   2. 既存 .env がある場合は skip + 上書きしない (idempotent)
#   3. .env.example 不在で exit 1 + stderr に message
# を観測する。
#
# 失敗時は exit 1 + 失敗 case 名を echo。 まとめて Makefile から呼ばれることを想定。

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# bun が PATH に無いと早期 fail (= CI runner 設定漏れの可能性)。
if ! command -v bun >/dev/null 2>&1; then
  echo "ERROR: bun が PATH に見つかりません" >&2
  exit 1
fi

# 一時 work dir を作って .env.example を seed → runEnvInit を call。
WORKDIR="$(mktemp -d -t tenkacloud-env-init.XXXXXX)"
trap 'rm -rf "$WORKDIR"' EXIT

ENV_DIR="$WORKDIR/infrastructure/environments/development"
mkdir -p "$ENV_DIR"
cat >"$ENV_DIR/.env.example" <<'EOF'
# Seed example for shell-level test.
TENANT_ADMIN_EMAIL=admin@example.com
SYSTEM_ADMIN_EMAIL=admin@example.com
AWS_REGION=ap-northeast-1
CDK_PARAM_DEPLOY_EXTERNAL_ID=tenkacloud-lite-default
EOF

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

# Case 1: 非対話 (= stdin closed) で `.env` が default 値で生成される。
( cd "$WORKDIR" && bun run "$REPO_ROOT/scripts/env-init.ts" </dev/null >/tmp/env-init-case1.out 2>&1 ) \
  || { cat /tmp/env-init-case1.out; fail "case1: env-init exited non-zero in non-interactive mode"; }
[ -f "$ENV_DIR/.env" ] || fail "case1: .env was not created"
grep -q "^TENANT_ADMIN_EMAIL=admin@example.com$" "$ENV_DIR/.env" || fail "case1: TENANT_ADMIN_EMAIL missing"
grep -q "^AWS_REGION=ap-northeast-1$" "$ENV_DIR/.env" || fail "case1: AWS_REGION missing"
grep -q "^CDK_PARAM_DEPLOY_EXTERNAL_ID=tenkacloud-lite-default$" "$ENV_DIR/.env" \
  || fail "case1: CDK_PARAM_DEPLOY_EXTERNAL_ID missing"
echo "OK case1: non-interactive default generation"

# Case 2: 2 度目の起動は skip (idempotent) で既存 .env を上書きしない。
echo "MARKER=preserved" >>"$ENV_DIR/.env"
( cd "$WORKDIR" && bun run "$REPO_ROOT/scripts/env-init.ts" </dev/null >/tmp/env-init-case2.out 2>&1 ) \
  || { cat /tmp/env-init-case2.out; fail "case2: env-init exited non-zero on re-run"; }
grep -q "MARKER=preserved" "$ENV_DIR/.env" || fail "case2: existing .env was overwritten"
grep -q "既に存在します" /tmp/env-init-case2.out || fail "case2: skip message not printed"
echo "OK case2: idempotent skip on re-run"

# Case 3: .env.example を消すと exit 1 + stderr に message。
rm "$ENV_DIR/.env"
rm "$ENV_DIR/.env.example"
set +e
( cd "$WORKDIR" && bun run "$REPO_ROOT/scripts/env-init.ts" </dev/null >/tmp/env-init-case3.out 2>&1 )
RC=$?
set -e
[ "$RC" -ne 0 ] || fail "case3: env-init should fail when .env.example is missing (got exit 0)"
grep -q "\.env\.example" /tmp/env-init-case3.out || fail "case3: stderr should mention .env.example"
echo "OK case3: missing .env.example -> exit 1"

echo "All env-init shell tests passed."
