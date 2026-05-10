#!/bin/bash -xe

export CDK_PARAM_CONTROL_PLANE_SOURCE='sbt-control-plane-api'
export CDK_PARAM_ONBOARDING_DETAIL_TYPE='Onboarding'
export CDK_PARAM_PROVISIONING_DETAIL_TYPE=$CDK_PARAM_ONBOARDING_DETAIL_TYPE
export CDK_PARAM_APPLICATION_NAME_PLANE_SOURCE="sbt-application-plane-api"
export CDK_PARAM_OFFBOARDING_DETAIL_TYPE='Offboarding'
export CDK_PARAM_DEPROVISIONING_DETAIL_TYPE=$CDK_PARAM_OFFBOARDING_DETAIL_TYPE
export CDK_PARAM_PROVISIONING_EVENT_SOURCE="sbt-application-plane-api"
export CDK_PARAM_CODE_COMMIT_REPOSITORY_NAME="aws-saas-factory-ref-solution-serverless-saas"
export CDK_PARAM_LAMBDA_CANARY_DEPLOYMENT_PREFERENCE="true"
export CDK_PARAM_SYSTEM_ADMIN_EMAIL="EMAIL"
export CDK_PARAM_TENANT_ID=$TENANT_ID

export REGION=$AWS_REGION
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

export CDK_PARAM_S3_BUCKET_NAME="tenkacloud-source-${ACCOUNT_ID}-${REGION}"
echo "CDK_PARAM_S3_BUCKET_NAME: ${CDK_PARAM_S3_BUCKET_NAME}"
export CDK_SOURCE_NAME="source.zip"

VERSIONS=$(aws s3api list-object-versions --bucket "$CDK_PARAM_S3_BUCKET_NAME" --prefix "$CDK_SOURCE_NAME" --query 'Versions[?IsLatest==`true`].{VersionId:VersionId}' --output text 2>&1)
export CDK_PARAM_COMMIT_ID=$(echo "$VERSIONS" | awk 'NR==1{print $1}')
echo "CDK_PARAM_COMMIT_ID: ${CDK_PARAM_COMMIT_ID}"

aws s3api get-object --bucket "$CDK_PARAM_S3_BUCKET_NAME" --key "$CDK_SOURCE_NAME" --version-id "$CDK_PARAM_COMMIT_ID" "$CDK_SOURCE_NAME" 2>&1
# `-o`: 既存ファイルを silent overwrite (CodeBuild は workspace 再利用でファイルが残ることが
# あり、prompt が出ると stdin EOF で `[N]one` 扱いになって展開不完全 → 後段 `cd cdk` などで
# silent fail。`-o` で必ず上書きする。
unzip -o $CDK_SOURCE_NAME

# Node version は **`.nvmrc` (= source of truth、repo root に commit、install.sh が
# source.zip 同梱)** を読み、NodeSource yum repo で OS-level に install。
# 旧 nvm 経由は CodeBuild image に nvm が無いケースで silent fail し、結局 default node 14 で
# cdk が "Unexpected token '{'" になる regression を起こした (#560)。NodeSource なら image 非依存。
# 上げる時は repo root の `.nvmrc` を 1 行書き換えるだけで全 script + ローカル dev に伝搬。
NODE_MAJOR=$(cut -d. -f1 .nvmrc)
echo "Installing Node.js ${NODE_MAJOR}.x via NodeSource yum repo..."
curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | sudo bash -
sudo yum install -y nodejs
node --version
npm --version
# Node 20 で global install された aws-cdk を入れ直す (= 古い node 14 binary を上書き)。
sudo npm install -g aws-cdk

cd cdk
npm install
npx cdk deploy "$STACK_NAME" --exclusively --require-approval never
