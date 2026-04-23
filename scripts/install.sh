#!/bin/bash
set -eo pipefail
# TenkaCloud orchestration entry — 全部 AWS で動かす 3-phase deploy
#
# Phase 1: Backend stacks (ControlPlane + Bootstrap + TenantTemplate-pooled + Pipeline)
# Phase 2: AdminConsoleHostingStack (client/AdminWeb を CloudFront+S3 配信)
#          ⚠️ AdminWeb は Next.js standalone のため pure S3+CloudFront には収まらない。
#             OpenNext on Lambda or AWS Amplify Hosting への移行検討中 (ADR-013 参照)。
# Phase 3: ControlPlaneStack 再 deploy (CloudFront URL を callback/CORS に追加)
#
# Usage:
#   bash scripts/install.sh "admin@example.com"
#
# 前提:
#   - aws CLI ログイン済み
#   - docker 起動済み (BucketDeployment bundling で使用)

export CDK_PARAM_SYSTEM_ADMIN_EMAIL="$1"

if [[ -z "$CDK_PARAM_SYSTEM_ADMIN_EMAIL" ]]; then
  echo "Please provide system admin email"
  exit 1
fi

export REGION=$(aws configure get region)
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

# --- Source bucket 準備 (CodeBuild が source.zip を取りに来る) ---
export CDK_PARAM_S3_BUCKET_NAME="tenkacloud-${ACCOUNT_ID}-${REGION}"
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

# CodeBuild 内の update-tenant.sh / provision-tenant.sh は zip 内に `cdk/` と `scripts/` が
# あることを想定するため、TenkaCloud のリポジトリ構造 (server/ / scripts/) を zip 用に
# `server` → `cdk` リネームした staging に並べてから zip する。
STAGING=$(mktemp -d)
trap "rm -rf '$STAGING'" EXIT

cd ..  # TenkaCloud root へ
echo "Staging source.zip at ${STAGING}..."
# server (CDK) → cdk にリネーム、scripts はそのまま
cp -R server "${STAGING}/cdk"
cp -R scripts "${STAGING}/scripts"

# node_modules / cdk.out / dist を完全に排除 (CodeBuild の npm install が EEXIST で失敗するため)
find "${STAGING}" -type d \( -name node_modules -o -name cdk.out -o -name dist \) -prune -exec rm -rf {} +
find "${STAGING}" -name ".DS_Store" -delete

# TenkaCloud ルートの絶対パスを記憶して最後に server/ に戻る
TENKACLOUD_ROOT="$(pwd)"

cd "${STAGING}"
zip -rq "${CDK_SOURCE_NAME}" .
export CDK_PARAM_COMMIT_ID=$(aws s3api put-object --bucket "${CDK_PARAM_S3_BUCKET_NAME}" --key "source.zip" --body "./${CDK_SOURCE_NAME}" --output text)
echo "Source code uploaded to S3 (layout: cdk/, scripts/)."

cd "${TENKACLOUD_ROOT}/server"

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
  ControlPlaneStack \
  tenkacloud-bootstrap-stack \
  tenkacloud-tenant-template-pooled \
  TenkaCloudPipeline \
  --require-approval never --concurrency 4

# ============================================================================
# Phase 2: AdminWeb build + hosting deploy
#   - Phase 1 の outputs を env に入れて client/AdminWeb を host 側で build
#     (bun workspace の node_modules 内シンボリックリンクが docker cp で壊れるので
#      host build → dist/ を S3 アップロードする形)
#   - AdminConsoleHostingStack を deploy (S3 + CloudFront)
#   ⚠️ AdminWeb は Next.js standalone のため pure S3+CloudFront には不適合。
#      暫定的にビルド後 dist/ を出力する想定だが、最終的には OpenNext (Lambda)
#      または Amplify Hosting への移行が必要 (ADR-013 参照)。
# ============================================================================
echo ""
echo "=============================================="
echo "Phase 2: Build admin-console + deploy CloudFront"
echo "=============================================="
API_URL=$(aws cloudformation describe-stacks --stack-name ControlPlaneStack --query "Stacks[0].Outputs[?OutputKey=='controlPlaneAPIEndpoint'].OutputValue" --output text)
USER_POOL_ID=$(aws cloudformation describe-stacks --stack-name ControlPlaneStack --query "Stacks[0].Outputs[?contains(OutputKey,'ControlPlaneIdpUserPoolId')].OutputValue" --output text)
CLIENT_ID=$(aws cloudformation describe-stacks --stack-name ControlPlaneStack --query "Stacks[0].Outputs[?contains(OutputKey,'ControlPlaneIdpClientId')].OutputValue" --output text)
COGNITO_DOMAIN_PREFIX=$(aws cognito-idp describe-user-pool --user-pool-id "${USER_POOL_ID}" --query "UserPool.Domain" --output text)
COGNITO_DOMAIN="https://${COGNITO_DOMAIN_PREFIX}.auth.${REGION}.amazoncognito.com"

echo "  API URL       : ${API_URL}"
echo "  ClientId      : ${CLIENT_ID}"
echo "  Cognito Domain: ${COGNITO_DOMAIN}"

# AdminWeb を host で build。URL は build に焼かない (runtime-config.json 経由で
# CDK が CloudFront に配置する)。dev ローカル開発では .env.local が効くので触らない。
cd "${TENKACLOUD_ROOT}/client/AdminWeb"
echo "  client/AdminWeb: bun install + next build (URL 非依存)"
bun install
bun run build
echo "  → dist/ generated"

# AdminConsoleHostingStack deploy: backend outputs を CDK_PARAM_* env に渡す
# (stack が runtime-config.json に書いて S3 に配置する)
cd "${TENKACLOUD_ROOT}/server"
export CDK_PARAM_CONTROL_PLANE_API_URL="${API_URL}"
export CDK_PARAM_CONTROL_PLANE_COGNITO_DOMAIN="${COGNITO_DOMAIN}"
export CDK_PARAM_CONTROL_PLANE_USER_CLIENT_ID="${CLIENT_ID}"
bunx cdk deploy AdminConsoleHostingStack --require-approval never

# ============================================================================
# Phase 3: ControlPlaneStack 再 deploy — CloudFront URL を callback/CORS に足す
# ============================================================================
echo ""
echo "=============================================="
echo "Phase 3: Update ControlPlaneStack with admin-console CloudFront URL"
echo "=============================================="
ADMIN_CONSOLE_URL=$(aws cloudformation describe-stacks --stack-name AdminConsoleHostingStack --query "Stacks[0].Outputs[?starts_with(OutputKey,'AdminConsoleUrl')].OutputValue" --output text)
export CDK_PARAM_ADMIN_CONSOLE_ORIGIN="${ADMIN_CONSOLE_URL}"
echo "  CloudFront URL: ${ADMIN_CONSOLE_URL}"
bunx cdk deploy ControlPlaneStack --require-approval never

# ============================================================================
# 完了
# ============================================================================
echo ""
echo "=============================================="
echo "Deploy complete!"
echo "=============================================="
echo ""
echo "Admin Console URL: ${ADMIN_CONSOLE_URL}"
echo ""
echo "1. SystemAdmin 初回招待メール (${CDK_PARAM_SYSTEM_ADMIN_EMAIL}) が届いてるはずなので開く"
echo "2. ${ADMIN_CONSOLE_URL}/control にブラウザで access (basePath=/control)"
echo "3. ログイン → /control/dashboard/tenants/new で tenant 作成 → 招待メールが飛ぶ"
