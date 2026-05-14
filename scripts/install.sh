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

export REGION=$(aws configure get region)
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

# --- Source bucket 準備 (ref 準拠) ---
export CDK_PARAM_S3_BUCKET_NAME="tenkacloud-source-${ACCOUNT_ID}-${REGION}"
echo "CDK_PARAM_S3_BUCKET_NAME: ${CDK_PARAM_S3_BUCKET_NAME}"
export CDK_SOURCE_NAME="source.zip"

if aws s3api head-bucket --bucket $CDK_PARAM_S3_BUCKET_NAME --expected-bucket-owner ${ACCOUNT_ID} 2>/dev/null; then
    echo "Bucket $CDK_PARAM_S3_BUCKET_NAME already exists and owned by this account."
else
    echo "Bucket $CDK_PARAM_S3_BUCKET_NAME does not exist. Creating..."
    if [ "$REGION" == "us-east-1" ]; then
      aws s3api create-bucket --bucket $CDK_PARAM_S3_BUCKET_NAME
    else
      aws s3api create-bucket --bucket $CDK_PARAM_S3_BUCKET_NAME --region "$REGION" --create-bucket-configuration LocationConstraint="$REGION"
    fi
    aws s3api put-bucket-versioning --bucket $CDK_PARAM_S3_BUCKET_NAME --versioning-configuration Status=Enabled
    aws s3api put-public-access-block --bucket $CDK_PARAM_S3_BUCKET_NAME --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
    echo "Bucket $CDK_PARAM_S3_BUCKET_NAME created."
fi

# ref の update-tenant.sh / provision-tenant.sh は zip 内に `cdk/` `src/` `scripts/` があることを想定する。
# TenkaCloud のリポジトリ構造 (infrastructure/ / src/ / scripts/) をそのまま zip すると、
# `cd cdk` が失敗して CodeBuild がコケる。ので一時 staging で ref 期待レイアウトに合わせる。
STAGING=$(mktemp -d)
trap "rm -rf '$STAGING'" EXIT

cd ..  # TenkaCloud root へ
TenkaCloud_ROOT="$(pwd)"

# apps/application-admin-console を host build。dist/ は 2 経路で参照される:
#   1. host 実行の phase 1 で pooled TenantTemplateStack を deploy する際の Source.asset
#   2. CodeBuild 実行の provision-tenant.sh が PLATINUM tier で per-tenant
#      TenantTemplateStack を deploy する際の Source.asset (source.zip 経由で持ち込む)
# 両方とも infrastructure/lib/tenant-template/application-admin-console-hosting.ts が
# path.join(__dirname, "..", "..", "..", "apps", "application-admin-console", "dist")
# で参照する。
echo "Building apps/application-admin-console (used by both pooled stack at host + silo stack in CodeBuild)..."
(cd "${TenkaCloud_ROOT}/apps/application-admin-console" && bun install && bun run build)
echo "  → dist/ generated"

# apps/participant-portal を host build。ProblemDeployBackendStack の
# ParticipantPortalHosting が `apps/participant-portal/dist/` を Source.asset で読む。
# `CDK_PARAM_ENABLE_PARTICIPANT_PORTAL=true` のときだけ stack 側で生成される。
echo "Building apps/participant-portal (used by ParticipantPortalHosting in ProblemDeployBackendStack)..."
(cd "${TenkaCloud_ROOT}/apps/participant-portal" && bun install && bun run build)
echo "  → dist/ generated"

# Participant Portal を ProblemDeployBackendStack に含める (CDK 側で条件付き作成)。
# eventTitle はオプション (default は "TenkaCloud Battle")。
export CDK_PARAM_ENABLE_PARTICIPANT_PORTAL="true"

echo "Staging source.zip at ${STAGING}..."
# infrastructure → cdk にリネーム、src と scripts はそのまま
cp -R infrastructure "${STAGING}/cdk"
cp -R scripts "${STAGING}/scripts"
# MVP-1 (ADR-001 PR-2): problems/ を含めて source.zip に同梱する。CodeBuild の deploy-battles.sh
# が `problems/<id>/template.yaml` を読むので、source.zip の root に problems/ を置く必要がある。
cp -R problems "${STAGING}/problems"
# `.nvmrc` を staging root に同梱 (= source of truth、CodeBuild 内 provision/update-tenant.sh が
# `nvm install $(cat .nvmrc)` で参照する)。repo root から copy。
cp "${TenkaCloud_ROOT}/.nvmrc" "${STAGING}/.nvmrc"
# 旧 ref-arch では src/ を staging に含めていたが、#76 で
# infrastructure/lib/tenant-pipeline/handlers/ に移動済 (cdk/ 配下に同梱されるので不要)。

# node_modules / cdk.out / bun.lock を完全に排除 (CodeBuild の npm install が EEXIST で失敗するため)
find "${STAGING}" -type d \( -name node_modules -o -name cdk.out -o -name dist \) -prune -exec rm -rf {} +
find "${STAGING}" -type f \( -name ".env" -o -name ".env.local" \) -delete
find "${STAGING}" -name ".DS_Store" -delete

# 上の find は dist を一括 prune するので、application-admin-console の dist は
# その後で個別に置き直す。CodeBuild の provision-tenant.sh が `cd cdk` した後に
# Source.asset で `../apps/application-admin-console/dist` を解決できる必要がある。
mkdir -p "${STAGING}/apps/application-admin-console"
cp -R "${TenkaCloud_ROOT}/apps/application-admin-console/dist" "${STAGING}/apps/application-admin-console/"

# participant-portal も dist を staging に置く。現状 ProblemDeployBackendStack は
# host 環境 (phase 1) でしか deploy されないので、host の `apps/participant-portal/dist`
# 直参照で動く。が、将来 CodeBuild から再 deploy する経路を増やしたとき、source.zip 内に
# dist が無いと Source.asset が解決できず失敗する。application-admin-console と同じ流儀
# で予め staging に同梱して将来リスクを抑える (claude-review PR 475 の指摘)。
mkdir -p "${STAGING}/apps/participant-portal"
cp -R "${TenkaCloud_ROOT}/apps/participant-portal/dist" "${STAGING}/apps/participant-portal/"

cd "${STAGING}"
zip -rq "${CDK_SOURCE_NAME}" .
export CDK_PARAM_COMMIT_ID=$(aws s3api put-object --bucket "${CDK_PARAM_S3_BUCKET_NAME}" --key "source.zip" --body "./${CDK_SOURCE_NAME}" --output text)
echo "Source code uploaded to S3 (layout: cdk/, src/, scripts/, apps/application-admin-console/dist/)."

cd "${TenkaCloud_ROOT}/infrastructure"

# JSII_DEPRECATED=quiet: SBT 内部の aws-cdk-lib deprecation warning を抑制 (CFT には影響なし)
export JSII_DEPRECATED=quiet

bun install
bunx cdk bootstrap

# ============================================================================
# Phase 1: backend stacks — admin-console URL はまだ無いので CORS/callback は
# localhost のみで deploy
# ============================================================================
echo ""
echo "=============================================="
echo "Phase 1: Deploy backend stacks"
echo "=============================================="
bunx cdk deploy \
  tenkacloud-control-plane \
  tenkacloud-bootstrap \
  tenkacloud-problem-deploy \
  tenkacloud-admin-console-insight \
  tenkacloud-tenant-template-pooled \
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
cd "${TenkaCloud_ROOT}/apps/admin-console"
echo "  apps/admin-console: bun install + vite build (URL 非依存)"
bun install
bun run build
echo "  → dist/ generated"

# pooled stack の application-admin-console URL も runtime-config に流す
# (admin-console から basic / standard / advanced tier の tenant 行で「開く」リンクを
# 出すため。silo platinum tenant は provision-tenant.sh が tenantConfig に書く)。
# pooled stack は phase 1 で既に立っているので CFn output から取れる。
POOLED_APP_CONSOLE_URL=$(aws cloudformation describe-stacks \
  --stack-name "tenkacloud-tenant-template-pooled" \
  --query "Stacks[0].Outputs[?OutputKey=='ApplicationAdminConsoleUrl'].OutputValue" \
  --output text)
echo "  Pooled App URL: ${POOLED_APP_CONSOLE_URL}"

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
cd "${TenkaCloud_ROOT}/infrastructure"
export CDK_PARAM_CONTROL_PLANE_API_URL="${API_URL}"
export CDK_PARAM_CONTROL_PLANE_COGNITO_DOMAIN="${COGNITO_DOMAIN}"
export CDK_PARAM_CONTROL_PLANE_USER_CLIENT_ID="${CLIENT_ID}"
export CDK_PARAM_POOLED_APP_CONSOLE_URL="${POOLED_APP_CONSOLE_URL}"
export CDK_PARAM_PROVISIONING_CODEBUILD_PROJECT="${PROVISIONING_CODEBUILD_PROJECT}"
export CDK_PARAM_AWS_REGION="${REGION}"
export CDK_PARAM_AWS_ACCOUNT_ID="${ACCOUNT_ID}"
export CDK_PARAM_ADMIN_INSIGHT_API_URL="${ADMIN_INSIGHT_API_URL}"
bunx cdk deploy tenkacloud-admin-console-hosting --require-approval never

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
bunx cdk deploy tenkacloud-control-plane tenkacloud-admin-console-insight tenkacloud-tenant-template-pooled --require-approval never

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
