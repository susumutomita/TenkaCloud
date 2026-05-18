#!/bin/bash
set -eo pipefail
# TenkaCloud orchestration entry — 全部 AWS で動かす 3-phase deploy
#
# Phase 1: Backend stacks (ControlPlane + Bootstrap + TenantTemplate-pooled + Pipeline)
# Phase 2: AdminConsoleHostingStack (React admin-console を CloudFront+S3 配信)
# Phase 3: ControlPlaneStack + admin-console-insight 再 deploy
#         (CloudFront URL を callback / CORS に追加、 #716)
#
# Usage:
#   bash scripts/install.sh "admin@example.com"
#
# 前提:
#   - aws CLI ログイン済み
#   - docker 起動済み (BucketDeployment bundling で使用)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export CDK_PARAM_SYSTEM_ADMIN_EMAIL="$1"

if [[ -z "$CDK_PARAM_SYSTEM_ADMIN_EMAIL" ]]; then
  echo "Please provide system admin email"
  exit 1
fi

# --- Source bucket 準備 + source.zip upload (= prepare-source-bundle.sh に集約) ---
#
# 旧来この install.sh 自体で bucket 作成 + apps build + staging + zip + upload を inline で
# 書いていたが (= 80 行 / 内容は tenkacloud-lite.ts cmdUp の Lite mode と完全に同じ)、 DRY
# 違反になっていた。 prepare-source-bundle.sh に shared logic を切り出し、 install.sh / lite
# 両方が同じ手順を踏むようにする。 source で呼ぶことで CDK_PARAM_S3_BUCKET_NAME /
# CDK_PARAM_COMMIT_ID 等の export を caller に持ち越す。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./prepare-source-bundle.sh
source "${SCRIPT_DIR}/prepare-source-bundle.sh"

# Participant Portal を ProblemDeployBackendStack に含める (CDK 側で条件付き作成)。
# eventTitle はオプション (default は "TenkaCloud Battle")。
export CDK_PARAM_ENABLE_PARTICIPANT_PORTAL="true"

# TENKACLOUD_ROOT は prepare-source-bundle.sh が export する。 install.sh の後段は
# infrastructure/ 配下で動作するため戻す。 source 経由で set -u が継承されるので、
# 以降の cd でも変数名は **全大文字** に揃える (= typo は unbound variable で fail する)。
cd "${TENKACLOUD_ROOT}/infrastructure"

# JSII_DEPRECATED=quiet: SBT 内部の aws-cdk-lib deprecation warning を抑制 (CFT には影響なし)
export JSII_DEPRECATED=quiet

bun install
bun cdk bootstrap

# ============================================================================
# Phase 1: backend stacks — admin-console URL はまだ無いので CORS/callback は
# localhost のみで deploy
# ============================================================================
echo ""
echo "=============================================="
echo "Phase 1: Deploy backend stacks"
echo "=============================================="
# Issue #1029 / PR-1028 follow-up: `tenkacloud-tenant-template-pooled` (= pooled tenants が
# 共有する App Plane stack) は install.sh からは deploy しない。 理由:
#   - install.sh が直 deploy すると stack が UPDATE_IN_PROGRESS の間 SBT Step Functions が
#     「Can we update Stack?」 = NO で Skip Deployment 分岐に倒れ、 CodeBuild が起動しない
#     → tenant update path が機能しない silent failure になる
#   - 役割分担を明確化: pooled stack の lifecycle (create / update) は SBT pipeline
#     (CodeBuild 経由) に一本化。 install.sh は Control Plane 系 stack + saas-pipeline まで
# 初回 install: pooled stack は未作成 (= 後で初 tenant 作成 trigger で SBT が初 create)
# 二度目以降: pooled stack は SBT pipeline が tenant event で update
bun cdk deploy \
  tenkacloud-control-plane \
  tenkacloud-bootstrap \
  tenkacloud-problem-deploy \
  tenkacloud-admin-console-insight \
  tenkacloud-saas-pipeline \
  --require-approval never --concurrency 4

# ============================================================================
# Phase 2: admin-console build + hosting deploy
#   - Phase 1 の outputs を env に入れて apps/admin-console を host 側で build
#     (bun workspace の node_modules 内シンボリックリンクが docker cp で壊れるので
#      host build → dist/ を S3 アップロードする形)
#   - AdminConsoleHostingStack を deploy (S3 + CloudFront)
# ============================================================================
echo ""
echo "=============================================="
echo "Phase 2: Build admin-console + deploy CloudFront"
echo "=============================================="
API_URL=$(aws cloudformation describe-stacks --stack-name tenkacloud-control-plane --query "Stacks[0].Outputs[?OutputKey=='controlPlaneAPIEndpoint'].OutputValue" --output text)
USER_POOL_ID=$(aws cloudformation describe-stacks --stack-name tenkacloud-control-plane --query "Stacks[0].Outputs[?contains(OutputKey,'ControlPlaneIdpUserPoolId')].OutputValue" --output text)
CLIENT_ID=$(aws cloudformation describe-stacks --stack-name tenkacloud-control-plane --query "Stacks[0].Outputs[?contains(OutputKey,'ControlPlaneIdpClientId')].OutputValue" --output text)
COGNITO_DOMAIN_PREFIX=$(aws cognito-idp describe-user-pool --user-pool-id "${USER_POOL_ID}" --query "UserPool.Domain" --output text)
COGNITO_DOMAIN="https://${COGNITO_DOMAIN_PREFIX}.auth.${REGION}.amazoncognito.com"

echo "  API URL       : ${API_URL}"
echo "  ClientId      : ${CLIENT_ID}"
echo "  Cognito Domain: ${COGNITO_DOMAIN}"

# admin-console を host で build。URL は build に焼かない (runtime-config.json 経由で
# CDK が CloudFront に配置する)。dev ローカル開発では .env.local が効くので触らない。
cd "${TENKACLOUD_ROOT}/apps/admin-console"
echo "  apps/admin-console: bun install + vite build (URL 非依存)"
bun install
bun run build
echo "  → dist/ generated"

# pooled stack の application-admin-console URL も runtime-config に流す
# (admin-console から basic / standard / advanced tier の tenant 行で「開く」リンクを
# 出すため。silo platinum tenant は provision-tenant.sh が tenantConfig に書く)。
#
# Issue #1029 / PR-1028 follow-up: pooled stack は SBT pipeline (CodeBuild) で create / update
# される設計なので、 初回 install (= 第 1 tenant 未作成) の時点では存在しない。 stack 不在は
# 空文字 fallback (= runtime-config に空 URL が入る、 admin-console は「pooled tenants 未配信」
# 扱いで UI 上 link を出さない / 空表示する)。 第 1 tenant 作成後に再 install.sh を走らせれば
# URL が伝播する。
POOLED_APP_CONSOLE_URL=$(aws cloudformation describe-stacks \
  --stack-name "tenkacloud-tenant-template-pooled" \
  --query "Stacks[0].Outputs[?OutputKey=='ApplicationAdminConsoleUrl'].OutputValue" \
  --output text 2>/dev/null || echo "")
if [ -z "${POOLED_APP_CONSOLE_URL}" ]; then
  echo "  Pooled App URL: (未作成、 第 1 tenant 作成後に SBT pipeline が pooled stack を初 create する)"
else
  echo "  Pooled App URL: ${POOLED_APP_CONSOLE_URL}"
fi

# 同 stack の CodeBuild プロジェクト名を AdminConsoleHostingStack に渡す
# (provisioning ログ deep link 構築で使う)。SBT BashJobRunner が立てる project の
# 名前は CFn output に直接無いので、tag フィルタで取得。
PROVISIONING_CODEBUILD_PROJECT=$(aws codebuild list-projects --output json \
  | jq -r '.projects[]' \
  | grep -i 'provisioning' \
  | head -n 1 || echo "")
if [ -z "${PROVISIONING_CODEBUILD_PROJECT}" ]; then
  echo "  Warning: provisioning CodeBuild project が見つからない (admin-console のログ link は無効化される)"
  PROVISIONING_CODEBUILD_PROJECT="unknown"
fi
echo "  Provisioning CodeBuild Project: ${PROVISIONING_CODEBUILD_PROJECT}"

# ADR-011 #590 Phase 1.A: AdminConsole Insight API URL を runtime-config に注入する。
# Phase 1 で立てた tenkacloud-admin-console-insight stack の CFn output を取得。
ADMIN_INSIGHT_API_URL=$(aws cloudformation describe-stacks \
  --stack-name "tenkacloud-admin-console-insight" \
  --query "Stacks[0].Outputs[?OutputKey=='AdminInsightApiUrl'].OutputValue" \
  --output text 2>/dev/null || echo "")
if [ -z "${ADMIN_INSIGHT_API_URL}" ]; then
  echo "  Warning: AdminInsightApiUrl が解決できない (admin-console の集計 column は無効化される)"
  ADMIN_INSIGHT_API_URL=""
fi
echo "  AdminInsight API URL: ${ADMIN_INSIGHT_API_URL}"

# AdminConsoleHostingStack deploy: backend outputs を CDK_PARAM_* env に渡す
# (stack が runtime-config.json に書いて S3 に配置する)
cd "${TENKACLOUD_ROOT}/infrastructure"
export CDK_PARAM_CONTROL_PLANE_API_URL="${API_URL}"
export CDK_PARAM_CONTROL_PLANE_COGNITO_DOMAIN="${COGNITO_DOMAIN}"
export CDK_PARAM_CONTROL_PLANE_USER_CLIENT_ID="${CLIENT_ID}"
export CDK_PARAM_POOLED_APP_CONSOLE_URL="${POOLED_APP_CONSOLE_URL}"
export CDK_PARAM_PROVISIONING_CODEBUILD_PROJECT="${PROVISIONING_CODEBUILD_PROJECT}"
export CDK_PARAM_AWS_REGION="${REGION}"
export CDK_PARAM_AWS_ACCOUNT_ID="${ACCOUNT_ID}"
export CDK_PARAM_ADMIN_INSIGHT_API_URL="${ADMIN_INSIGHT_API_URL}"
bun cdk deploy tenkacloud-admin-console-hosting --require-approval never

# ============================================================================
# Phase 3: ControlPlaneStack + admin-console-insight 再 deploy
#   - control-plane の Cognito callback / OAuth allow-list に CloudFront URL を追加
#   - admin-console-insight の HTTP API CORS allow-list にも同 URL を追加 (#716)
#     旧実装は control-plane のみ再 deploy しており、 admin-console-insight の CORS は
#     Phase 1 時点の localhost-only のままで Provisioning Jobs page が "Failed to fetch"
#     を吐いていた。
# ============================================================================
echo ""
echo "=============================================="
echo "Phase 3: Update tenkacloud-control-plane + admin-console-insight with admin-console CloudFront URL"
echo "=============================================="
ADMIN_CONSOLE_URL=$(aws cloudformation describe-stacks --stack-name tenkacloud-admin-console-hosting --query "Stacks[0].Outputs[?starts_with(OutputKey,'AdminConsoleUrl')].OutputValue" --output text)
export CDK_PARAM_ADMIN_CONSOLE_ORIGIN="${ADMIN_CONSOLE_URL}"
echo "  CloudFront URL: ${ADMIN_CONSOLE_URL}"
# #718: AdminConsoleHostingStack の CompetitorBootstrapTemplateUrl output を取得し、
# tenant-template-pooled に env 経由で再 inject する。 これにより application-admin-console の
# runtime-config.json に S3 URL が埋まり、 Launch Stack / Update Stack の CFn TemplateURL が
# S3 URL になる (= 旧 GitHub raw は CFn が reject していた)。
COMPETITOR_BOOTSTRAP_TEMPLATE_URL=$(aws cloudformation describe-stacks --stack-name tenkacloud-admin-console-hosting --query "Stacks[0].Outputs[?starts_with(OutputKey,'CompetitorBootstrapTemplateUrl')].OutputValue" --output text)
export CDK_PARAM_COMPETITOR_BOOTSTRAP_TEMPLATE_URL="${COMPETITOR_BOOTSTRAP_TEMPLATE_URL}"
echo "  Competitor bootstrap template URL: ${COMPETITOR_BOOTSTRAP_TEMPLATE_URL}"
# Issue #1029 / PR-1028 follow-up: pooled stack は SBT pipeline (CodeBuild) で update する
# 設計なので install.sh では deploy しない。 CDK_PARAM_COMPETITOR_BOOTSTRAP_TEMPLATE_URL が
# pooled stack に伝播するのは、 次の tenant event で CodeBuild が走ったとき
# (update-tenant.sh が同 CFn output を読んで env に流す、 別 commit で対応)。
bun cdk deploy tenkacloud-control-plane tenkacloud-admin-console-insight --require-approval never

# ============================================================================
# 完了
# ============================================================================
# pooled stack の application-admin-console URL を取得 (basic / standard / premium
# tenant が共有する 1 console)。silo (PLATINUM) tenant の URL は admin-console の
# テナント一覧から開けるので install.sh 側では出さない。
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
echo "4. テナント一覧の「Application Console を開く」ボタンから per-tenant URL を開く"
echo "   (PLATINUM tier のみ、pooled tier は上記 pooled URL を直接共有)"
