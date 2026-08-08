#!/bin/bash
# `set -e` を shebang に書いてはいけない。 CodeBuild は本 script を buildspec へ inline し、
# **1 つのコマンドブロック**として既に動いている shell に流し込むため、 shebang は解釈されず
# ただのコメントになる (build log の `Running command #!/bin/bash -e` が実物)。 結果 `-e` は
# 一度も有効にならず、 block の終了ステータスは最後の `export tenantStatus="Complete"` の 0 に
# なる。
#
# 実害 (2026-08-08 testsilo): silo の `cdk deploy` が Docker bundling 失敗で落ち、 続く
# describe-stacks が 4 本とも "Stack ... does not exist" で失敗し、 Cognito 呼び出しも空の
# UserPoolId で ParamValidation に落ちたのに、 CodeBuild は BUILD SUCCEEDED を返した。
# Step Functions も SUCCEEDED になり、 tenant は endpoint が全部空文字のまま "Complete" として
# 登録された (= 中身の無い platinum tenant)。
#
# よって shebang に頼らず実文として set する。
set -e
# pipefail: `curl ... | sudo bash -` の curl 失敗を silent に続行させない (NodeSource bootstrap
# が壊れた download で古い node のまま動いて debug 困難になるのを防ぐ、#560 の延長)。
set -o pipefail

# Install dependencies
sudo yum update -y
sudo yum install -y jq
sudo yum install -y python3-pip
# `--ignore-installed`: CodeBuild の base image では setuptools が rpm 管理下にあり、 素の
# `--upgrade` は uninstall 段階で必ず失敗する:
#
#   ERROR: Cannot uninstall setuptools 59.6.0, RECORD file not found.
#   Hint: The package was installed by rpm.
#
# `set -e` が効いていなかった間はこの失敗が無視されて先へ進んでいた (= 誰も気付かなかった)。
# errexit を入れた途端、 provisioning が cdk deploy まで到達せずここで止まるようになったので、
# uninstall を経由しない形にして実際に成功させる。 握り潰して先へ進めるのは、 元の欠陥に戻る。
sudo python3 -m pip install --upgrade --ignore-installed setuptools

# Enable nocasematch option
shopt -s nocasematch

# Source-bundle fetch preamble is shared with deprovision-tenant.sh and inlined here
# at synth time from scripts/lib/fetch-source-bundle.sh (#2217). It resolves
# account/region, reads the injected CDK_PARAM_S3_BUCKET_NAME, and downloads + unzips
# source.zip. Runs before the bundle exists, so it cannot be `source`d at runtime.
# @@INJECT:fetch-source-bundle@@

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
# admin-console から POST /tenant-registrations 時に渡された tenantName。runtime-config.json
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
  # synth は app 全体を構築するので、 何もしないと deploy 対象ですらない ControlPlaneStack の
  # Python Lambda まで Docker build しに行き、 CodeBuild 上でその build が落ちて silo deploy が
  # 丸ごと失敗する (2026-08-08 testsilo: `pip install pipenv poetry` が exit 255)。 bundle 対象を
  # これから deploy する stack だけに絞る。
  export CDK_BUNDLING_STACKS="$STACK_NAME"
  # `--exclusively` は CDK_BUNDLING_STACKS と必ず対。 これが無いと依存 stack (= 例えば
  # tenkacloud-problem-deploy) が deploy 対象に含まれ、 bundle を skip した **stub asset** の
  # まま本番 stack を上書きしてしまう。
  bun run cdk -- deploy "$STACK_NAME" --exclusively --require-approval never
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

# `describe-stacks --query ... --output text` は stack が在っても **OutputKey が無ければ空文字を
# exit 0 で返す**。 `set -e` では捕まらないので明示的に検査する。 ここを素通りさせると、
# endpoint が全部空の tenantConfig を "Complete" として書き戻してしまう (= 中身の無い tenant)。
require_stack_output() {
  local output_key="$1"
  local value="$2"
  if [[ -z "${value}" || "${value}" == "None" ]]; then
    echo "ERROR: stack '${STACK_NAME}' の output '${output_key}' が空です。" >&2
    echo "       tenant provisioning を中断します (= tenant を Complete にしない)。" >&2
    exit 1
  fi
}
require_stack_output "$USER_POOL_OUTPUT_PARAM_NAME" "$SAAS_APP_USERPOOL_ID"
require_stack_output "$APP_CLIENT_ID_OUTPUT_PARAM_NAME" "$SAAS_APP_CLIENT_ID"
require_stack_output "$API_GATEWAY_URL_OUTPUT_PARAM_NAME" "$API_GATEWAY_URL"
require_stack_output "$APPLICATION_ADMIN_CONSOLE_URL_OUTPUT_PARAM_NAME" "$APPLICATION_ADMIN_CONSOLE_URL"

# Create tenant admin user (idempotent — provisioning が中途で失敗 → SBT が再実行
# したとき UsernameExistsException で死なないよう、既存 user は skip)。
# Issue #748: custom:tenantName を一緒に埋める (= application-admin-console の Home 画面が
# JWT claim から「ようこそ {tenantName} さん」を表示する。 未設定だと ULID にフォールバックする)。
# CDK_PARAM_TENANT_NAME は SBT ProvisioningScriptJob 経由で `$.detail.tenantName` から伝搬。
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
export registrationStatus="Complete"
