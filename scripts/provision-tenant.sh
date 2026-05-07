#!/bin/bash -e

# Install dependencies
sudo yum update -y
sudo yum install -y nodejs
sudo yum install -y jq
sudo yum install -y python3-pip
sudo yum install -y npm
sudo npm install -g aws-cdk
sudo python3 -m pip install --upgrade setuptools

# Enable nocasematch option
shopt -s nocasematch

export REGION=$AWS_REGION
echo "REGION: ${REGION}"

export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
echo "ACCOUNT_ID: ${ACCOUNT_ID}"

# Download serverless reference solution from S3 bucket.
export CDK_PARAM_S3_BUCKET_NAME="tenkacloud-source-${ACCOUNT_ID}-${REGION}"
echo "CDK_PARAM_S3_BUCKET_NAME: ${CDK_PARAM_S3_BUCKET_NAME}"
export CDK_SOURCE_NAME="source.zip"

VERSIONS=$(aws s3api list-object-versions --bucket "$CDK_PARAM_S3_BUCKET_NAME" --prefix "$CDK_SOURCE_NAME" --query 'Versions[?IsLatest==`true`].{VersionId:VersionId}' --output text 2>&1)
CDK_PARAM_COMMIT_ID=$(echo "$VERSIONS" | awk 'NR==1{print $1}')
echo "CDK_PARAM_COMMIT_ID: ${CDK_PARAM_COMMIT_ID}"

aws s3api get-object --bucket "$CDK_PARAM_S3_BUCKET_NAME" --key "$CDK_SOURCE_NAME" --version-id "$CDK_PARAM_COMMIT_ID" "$CDK_SOURCE_NAME" 2>&1
unzip $CDK_SOURCE_NAME

cd cdk
npm install

# Parse tenant details from the input message from step function
export CDK_PARAM_TENANT_ID=$tenantId
# admin-console から POST /tenants 時に渡された tenantName。runtime-config.json
# 経由で application-admin-console の画面表示に使う (#48)。
export CDK_PARAM_TENANT_NAME=$tenantName
export TIER=$tier
export TENANT_ADMIN_EMAIL=$email

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
  cdk deploy $STACK_NAME --require-approval never
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

# Create tenant admin user
aws cognito-idp admin-create-user \
  --user-pool-id "$SAAS_APP_USERPOOL_ID" \
  --username "$TENANT_ADMIN_USERNAME" \
  --user-attributes Name=email,Value="$TENANT_ADMIN_EMAIL" Name=email_verified,Value="True" Name=phone_number,Value="+11234567890" Name="custom:userRole",Value="TenantAdmin" Name="custom:tenantId",Value="$CDK_PARAM_TENANT_ID" Name="custom:tenantTier",Value="$TIER" \
  --desired-delivery-mediums EMAIL

# Create tenant user group
aws cognito-idp create-group \
  --user-pool-id "$SAAS_APP_USERPOOL_ID" \
  --group-name "$CDK_PARAM_TENANT_ID"

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
