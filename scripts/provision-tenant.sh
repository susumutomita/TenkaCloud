#!/bin/bash -e
# pipefail: `curl ... | sudo bash -` の curl 失敗を silent に続行させない (NodeSource bootstrap
# が壊れた download で古い node のまま動いて debug 困難になるのを防ぐ、#560 の延長)。
set -o pipefail

# Install dependencies
sudo yum update -y
sudo yum install -y jq
sudo yum install -y python3-pip
sudo python3 -m pip install --upgrade setuptools

# Enable nocasematch option
shopt -s nocasematch

export REGION=$AWS_REGION
echo "REGION: ${REGION}"

export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
echo "ACCOUNT_ID: ${ACCOUNT_ID}"

# Download serverless reference solution from S3 bucket.
# #2194: CDK_PARAM_S3_BUCKET_NAME is injected by the provisioning ScriptJob env with
# the resolved (per-environment) bucket name the deploy actually created. Do NOT
# recompute it here — this runs before source.zip is unzipped (so scripts/lib/names.sh
# is unavailable), and the old local recompute diverged from the real hashed name,
# making provisioning read a non-existent bucket. Fail loud if it is missing.
if [ -z "${CDK_PARAM_S3_BUCKET_NAME:-}" ]; then
  echo "ERROR: CDK_PARAM_S3_BUCKET_NAME is not set (expected from the provisioning ScriptJob env)" >&2
  exit 1
fi
echo "CDK_PARAM_S3_BUCKET_NAME: ${CDK_PARAM_S3_BUCKET_NAME}"
export CDK_SOURCE_NAME="source.zip"

VERSIONS=$(aws s3api list-object-versions --bucket "$CDK_PARAM_S3_BUCKET_NAME" --prefix "$CDK_SOURCE_NAME" --query 'Versions[?IsLatest==`true`].{VersionId:VersionId}' --output text 2>&1)
CDK_PARAM_COMMIT_ID=$(echo "$VERSIONS" | awk 'NR==1{print $1}')
echo "CDK_PARAM_COMMIT_ID: ${CDK_PARAM_COMMIT_ID}"

aws s3api get-object --bucket "$CDK_PARAM_S3_BUCKET_NAME" --key "$CDK_SOURCE_NAME" --version-id "$CDK_PARAM_COMMIT_ID" "$CDK_SOURCE_NAME" 2>&1
# `-o`: 既存ファイルを silent overwrite (CodeBuild の workspace 再利用で残ったファイルに対し、
# prompt が出ると stdin EOF で `[N]one` 扱い → 展開不完全 → 後段で silent fail するのを防ぐ)。
unzip -o $CDK_SOURCE_NAME

# shellcheck source=lib/install-node.sh
source ./scripts/lib/install-node.sh
install_node_from_nvmrc

cd cdk
# Issue #916 (2 層目): `infrastructure/package.json` は `@TenkaCloud/trust-bridge:
# workspace:*` で sibling workspace を参照する。 npm は `workspace:` protocol を理解せず
# `EUNSUPPORTEDPROTOCOL` で fail するので bun install に切替。 staging root の monorepo
# package.json (= install.sh が copy) と `packages/trust-bridge` (= install.sh が
# 同梱) が揃った状態で bun が workspace resolve する。
bun install

# Parse tenant details from the input message from step function
export CDK_PARAM_TENANT_ID=$tenantId
# admin-console から POST /tenants 時に渡された tenantName。runtime-config.json
# 経由で application-admin-console の画面表示に使う (#48)。
export CDK_PARAM_TENANT_NAME=$tenantName
# Issue #1029 follow-up: tier は admin-console から大文字 (PLATINUM) で渡ってくる場合と
# 小文字 (platinum) で渡ってくる場合の両方を扱うため、 比較する前に大文字に正規化する。
# 小文字のまま `[[ $TIER == "PLATINUM" ]]` を通すと silo 分岐に入らず pooled に倒れ、
# admin-console UI の Application Console column が「Open ↗ (pooled)」 と表示される
# bug が観測された (2026-05-18 testsilo tenant)。
export TIER=$(echo "$tier" | tr '[:lower:]' '[:upper:]')
export TENANT_ADMIN_EMAIL=$email

# Issue #1053: hosting を ProblemDeployBackendStack に移管したので、 env-var で
# CompetitorBootstrapTemplateUrl を inject する経路は不要。 pooled / silo stack は cross-stack
# ref で `tenkacloud-problem-deploy` から URL を import する (= synth が CFn 上で解決)。

# Issue #1038 P2 #13: install.sh と同じ default を入れて、 SBT pipeline (CodeBuild) が pooled /
# silo stack を synth したときに `enableParticipantPortal=false` に regress するのを防ぐ。
# これが無いと `problemDeployBackendStack.participantPortalUrl` が undefined になり、
# pooled stack の runtime-config に `participantPortalUrl` が焼かれない (= user 観測
# 「Application Console に Participant Portal URL 未注入」)。
export CDK_PARAM_ENABLE_PARTICIPANT_PORTAL="true"
echo "CDK_PARAM_ENABLE_PARTICIPANT_PORTAL: ${CDK_PARAM_ENABLE_PARTICIPANT_PORTAL}"

# Define variables
TENANT_ADMIN_USERNAME="tenant-admin-$CDK_PARAM_TENANT_ID"
STACK_NAME="tenkacloud-tenant-template-pooled"
USER_POOL_OUTPUT_PARAM_NAME="TenantUserpoolId"
API_GATEWAY_URL_OUTPUT_PARAM_NAME="ApiGatewayUrl"
APP_CLIENT_ID_OUTPUT_PARAM_NAME="UserPoolClientId"
APPLICATION_ADMIN_CONSOLE_URL_OUTPUT_PARAM_NAME="ApplicationAdminConsoleUrl"

# Deploy the tenant template for platinum tier(silo)
if [[ $TIER == "PLATINUM" ]]; then
  STACK_NAME="tenkacloud-tenant-template-$CDK_PARAM_TENANT_ID"
  export CDK_PARAM_CONTROL_PLANE_SOURCE='sbt-control-plane-api'
  export CDK_PARAM_ONBOARDING_DETAIL_TYPE='Onboarding'
  export CDK_PARAM_PROVISIONING_DETAIL_TYPE=$CDK_PARAM_ONBOARDING_DETAIL_TYPE
  export CDK_PARAM_OFFBOARDING_DETAIL_TYPE='Offboarding'
  export CDK_PARAM_DEPROVISIONING_DETAIL_TYPE=$CDK_PARAM_OFFBOARDING_DETAIL_TYPE
  export CDK_PARAM_PROVISIONING_EVENT_SOURCE="sbt-application-plane-api"
  export CDK_PARAM_APPLICATION_NAME_PLANE_SOURCE="sbt-application-plane-api"
  bun cdk deploy "$STACK_NAME" --require-approval never
fi

# Read tenant details from the cloudformation stack output parameters
SAAS_APP_USERPOOL_ID=$(aws cloudformation describe-stacks --stack-name $STACK_NAME --query "Stacks[0].Outputs[?OutputKey=='$USER_POOL_OUTPUT_PARAM_NAME'].OutputValue" --output text)
SAAS_APP_CLIENT_ID=$(aws cloudformation describe-stacks --stack-name $STACK_NAME --query "Stacks[0].Outputs[?OutputKey=='$APP_CLIENT_ID_OUTPUT_PARAM_NAME'].OutputValue" --output text)
API_GATEWAY_URL=$(aws cloudformation describe-stacks --stack-name $STACK_NAME --query "Stacks[0].Outputs[?OutputKey=='$API_GATEWAY_URL_OUTPUT_PARAM_NAME'].OutputValue" --output text)
# silo (PLATINUM) は per-tenant stack の application-admin-console URL を fetch。
# pooled tenant の場合、STACK_NAME は共有 pooled stack なので同じ shared URL を読む
# (admin-console ではこの URL は表示しない方針 — pooled は install.sh の最終出力で
# operator が確認する)。
APPLICATION_ADMIN_CONSOLE_URL=$(aws cloudformation describe-stacks --stack-name $STACK_NAME --query "Stacks[0].Outputs[?OutputKey=='$APPLICATION_ADMIN_CONSOLE_URL_OUTPUT_PARAM_NAME'].OutputValue" --output text)

# Create tenant admin user (idempotent — provisioning が中途で失敗 → SBT が再実行
# したとき UsernameExistsException で死なないよう、既存 user は skip)。
# Issue #748: custom:tenantName を一緒に埋める (= application-admin-console の Home 画面が
# JWT claim から「ようこそ {tenantName} さん」を表示する。 未設定だと ULID にフォールバックする)。
# CDK_PARAM_TENANT_NAME は SBT BashJobRunner 経由で `$.detail.tenantName` から伝搬。
# 空のときは Cognito 属性に空文字を入れる (= 画面側で "(未設定)" 表示にフォールバック)。
if aws cognito-idp admin-get-user --user-pool-id "$SAAS_APP_USERPOOL_ID" --username "$TENANT_ADMIN_USERNAME" >/dev/null 2>&1; then
  echo "Tenant admin user already exists: $TENANT_ADMIN_USERNAME (update custom:tenantName)"
  # 既存 user (= #748 fix 前に作成された user) には custom:tenantName が無いので
  # admin-update-user-attributes で埋め直す。 同じ値で 2 回呼んでも no-op で安全。
  aws cognito-idp admin-update-user-attributes \
    --user-pool-id "$SAAS_APP_USERPOOL_ID" \
    --username "$TENANT_ADMIN_USERNAME" \
    --user-attributes Name="custom:tenantName",Value="$CDK_PARAM_TENANT_NAME"
else
  aws cognito-idp admin-create-user \
    --user-pool-id "$SAAS_APP_USERPOOL_ID" \
    --username "$TENANT_ADMIN_USERNAME" \
    --user-attributes Name=email,Value="$TENANT_ADMIN_EMAIL" Name=email_verified,Value="True" Name=phone_number,Value="+11234567890" Name="custom:userRole",Value="TenantAdmin" Name="custom:tenantId",Value="$CDK_PARAM_TENANT_ID" Name="custom:tenantTier",Value="$TIER" Name="custom:tenantName",Value="$CDK_PARAM_TENANT_NAME" \
    --desired-delivery-mediums EMAIL
fi

# Create tenant user group (idempotent — 再実行で GroupExistsException にならないよう skip)
if aws cognito-idp get-group --user-pool-id "$SAAS_APP_USERPOOL_ID" --group-name "$CDK_PARAM_TENANT_ID" >/dev/null 2>&1; then
  echo "Tenant user group already exists: $CDK_PARAM_TENANT_ID (skip create)"
else
  aws cognito-idp create-group \
    --user-pool-id "$SAAS_APP_USERPOOL_ID" \
    --group-name "$CDK_PARAM_TENANT_ID"
fi

# Add tenant admin user to tenant user group
aws cognito-idp admin-add-user-to-group \
  --user-pool-id "$SAAS_APP_USERPOOL_ID" \
  --username "$TENANT_ADMIN_USERNAME" \
  --group-name "$CDK_PARAM_TENANT_ID"

# Capture CodeBuild build identification for provisioning log deep link (#57).
# CODEBUILD_BUILD_ID = "{projectName}:{uuid}", AWS_REGION は CodeBuild が auto-set。
PROVISIONING_BUILD_ID="${CODEBUILD_BUILD_ID:-unknown}"
PROVISIONING_PROJECT_NAME=$(echo "$PROVISIONING_BUILD_ID" | cut -d: -f1)
PROVISIONING_REGION="${AWS_REGION:-unknown}"
PROVISIONING_ACCOUNT_ID="${ACCOUNT_ID:-unknown}"

# Create JSON response of output parameters
export tenantConfig=$(jq --arg SAAS_APP_USERPOOL_ID "$SAAS_APP_USERPOOL_ID" \
  --arg SAAS_APP_CLIENT_ID "$SAAS_APP_CLIENT_ID" \
  --arg API_GATEWAY_URL "$API_GATEWAY_URL" \
  --arg APPLICATION_ADMIN_CONSOLE_URL "$APPLICATION_ADMIN_CONSOLE_URL" \
  --arg PROVISIONING_BUILD_ID "$PROVISIONING_BUILD_ID" \
  --arg PROVISIONING_PROJECT_NAME "$PROVISIONING_PROJECT_NAME" \
  --arg PROVISIONING_REGION "$PROVISIONING_REGION" \
  --arg PROVISIONING_ACCOUNT_ID "$PROVISIONING_ACCOUNT_ID" \
  -n '{
    "userPoolId":$SAAS_APP_USERPOOL_ID,
    "appClientId":$SAAS_APP_CLIENT_ID,
    "apiGatewayUrl":$API_GATEWAY_URL,
    "applicationAdminConsoleUrl":$APPLICATION_ADMIN_CONSOLE_URL,
    "provisioningBuildId":$PROVISIONING_BUILD_ID,
    "provisioningProjectName":$PROVISIONING_PROJECT_NAME,
    "provisioningRegion":$PROVISIONING_REGION,
    "provisioningAccountId":$PROVISIONING_ACCOUNT_ID
  }')
export tenantStatus="Complete"
