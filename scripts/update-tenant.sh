#!/bin/bash -xe
# pipefail: `curl ... | sudo bash -` の curl 失敗を silent に続行させない (#560 の延長)。
set -o pipefail

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
# `-o`: 既存ファイルを silent overwrite (CodeBuild の workspace 再利用で残ったファイルに対し、
# prompt が出ると stdin EOF で `[N]one` 扱い → 展開不完全 → 後段で silent fail するのを防ぐ)。
unzip -o $CDK_SOURCE_NAME

# shellcheck source=lib/install-node.sh
source ./scripts/lib/install-node.sh
install_node_from_nvmrc

cd cdk
# Issue #916 (2 層目): `infrastructure/package.json` は \`@TenkaCloud/trust-bridge:
# workspace:*\` で sibling workspace を参照する。 npm は \`workspace:\` protocol を理解せず
# \`EUNSUPPORTEDPROTOCOL\` で fail するので bun install に切替。 staging root の monorepo
# package.json (= install.sh が copy) と \`packages/trust-bridge\` (= install.sh が
# 同梱) が揃った状態で bun が workspace resolve する。
bun install
bunx cdk deploy "$STACK_NAME" --exclusively --require-approval never
