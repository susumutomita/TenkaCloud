#!/bin/bash
set -eo pipefail
# TenkaCloud orchestration entry — `cdk deploy --all` 1 発で完結 (Issue #1031)。
#
# 旧 install.sh は Phase 1 (backend) → Phase 2 (admin-console-hosting) → Phase 3 (control-plane
# 再 deploy) の 3 段だった。 admin-console URL の chicken-and-egg を env-var dance で解いていた
# が、 Issue #1031 で admin-console-hosting を cross-stack ref で最初に立てる構造に reshape し、
# CDK が依存解決して 1 発 deploy できるようになった。
#
# Usage:
#   bash scripts/install.sh "admin@example.com"
#
# 前提:
#   - aws CLI ログイン済み
#   - docker 起動済み (= BucketDeployment bundling 用)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export CDK_PARAM_SYSTEM_ADMIN_EMAIL="$1"

if [[ -z "$CDK_PARAM_SYSTEM_ADMIN_EMAIL" ]]; then
  echo "Please provide system admin email"
  exit 1
fi

# Source bucket 準備 + source.zip upload (= prepare-source-bundle.sh が DRY 集約点)。
# CDK_PARAM_S3_BUCKET_NAME / CDK_PARAM_COMMIT_ID / TENKACLOUD_ROOT を export する。
# shellcheck source=./prepare-source-bundle.sh
source "${SCRIPT_DIR}/prepare-source-bundle.sh"

# SBT 内部の aws-cdk-lib deprecation warning を抑制 (CFT には影響なし)。
export JSII_DEPRECATED=quiet
# Participant Portal を ProblemDeployBackendStack に含める (= CDK 側で条件付き作成)。
export CDK_PARAM_ENABLE_PARTICIPANT_PORTAL="true"

# prepare-source-bundle.sh builds all three SPA dist directories before packaging,
# which also satisfies the following local CDK synth/deploy asset lookup.

cd "${TENKACLOUD_ROOT}/infrastructure"
bun install
bun run cdk -- bootstrap

# ============================================================================
# Single-phase deploy (Issue #1031): admin-console-hosting → control-plane / 他 backend →
# admin-console-runtime-config の依存グラフを CDK が解決して 1 発で全 stack を立てる。
#
# pooled stack (`tenkacloud-tenant-template-pooled`) は SBT pipeline (CodeBuild) で
# create / update する設計のため install.sh からは deploy しない (Issue #1029 / PR-1028)。
# runtime-config の pooledApplicationAdminConsoleUrl は初回 install では空文字 fallback、
# 第 1 tenant 作成後の再 install で SBT が立てた pooled stack の URL が cross-stack ref で
# 焼かれる。
# ============================================================================
echo ""
echo "=============================================="
echo "Deploying all stacks (cdk deploy --all)"
echo "=============================================="
bun run cdk -- deploy --all \
  --exclusively \
  --require-approval never \
  --concurrency 4

# ============================================================================
# 完了
# ============================================================================
ADMIN_CONSOLE_URL=$(aws cloudformation describe-stacks \
  --stack-name "tenkacloud-admin-console-hosting" \
  --query "Stacks[0].Outputs[?starts_with(OutputKey,'AdminConsoleUrl')].OutputValue" \
  --output text 2>/dev/null || echo "(missing)")

POOLED_APP_CONSOLE_URL=$(aws cloudformation describe-stacks \
  --stack-name "tenkacloud-tenant-template-pooled" \
  --query "Stacks[0].Outputs[?OutputKey=='ApplicationAdminConsoleUrl'].OutputValue" \
  --output text 2>/dev/null || echo "(not deployed yet)")

PARTICIPANT_PORTAL_URL=$(aws cloudformation describe-stacks \
  --stack-name "tenkacloud-problem-deploy" \
  --query "Stacks[0].Outputs[?OutputKey=='ParticipantPortalUrl'].OutputValue" \
  --output text 2>/dev/null || echo "(not deployed)")

echo ""
echo "=============================================="
echo "Deploy complete!"
echo "=============================================="
echo ""
echo "Admin Console URL                  : ${ADMIN_CONSOLE_URL}"
echo "Application Admin Console (pooled) : ${POOLED_APP_CONSOLE_URL}"
echo "Participant Portal URL             : ${PARTICIPANT_PORTAL_URL}"
echo ""
echo "1. SystemAdmin 初回招待メール (${CDK_PARAM_SYSTEM_ADMIN_EMAIL}) が届いてるはずなので開く"
echo "2. ${ADMIN_CONSOLE_URL} にブラウザで access"
echo "3. ログイン → テナント作成画面で tenant 作成 → 招待メールが飛ぶ"
echo "4. テナント一覧の「Application Console を開く」 ボタンから per-tenant URL を開く"
echo "   (PLATINUM tier のみ、 pooled tier は上記 pooled URL を直接共有)"
