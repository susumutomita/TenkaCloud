#!/bin/bash
# `-xe` は shebang でなく実文で set する。 CodeBuild は本 script を buildspec へ inline し、
# 1 つのコマンドブロックとして実行するので shebang は解釈されない (詳細は provision-tenant.sh
# の同じ箇所)。 shebang 任せだとトレースも errexit も効かない。
set -e
set -x
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

# Issue #1053: hosting を ProblemDeployBackendStack に移管したので、 env-var で
# CompetitorBootstrapTemplateUrl を inject する経路は不要。 pooled stack は cross-stack ref で
# `tenkacloud-problem-deploy` から URL を import する (= synth が CFn 上で解決)。

VERSIONS=$(aws s3api list-object-versions --bucket "$CDK_PARAM_S3_BUCKET_NAME" --prefix "$CDK_SOURCE_NAME" --query 'Versions[?IsLatest==`true`].{VersionId:VersionId}' --output text 2>&1)
export CDK_PARAM_COMMIT_ID=$(echo "$VERSIONS" | awk 'NR==1{print $1}')
echo "CDK_PARAM_COMMIT_ID: ${CDK_PARAM_COMMIT_ID}"

# Issue #1038 P2 #13: install.sh は `CDK_PARAM_ENABLE_PARTICIPANT_PORTAL=true` で synth するため、
# `problemDeployBackendStack` は `participantPortalUrl` を CfnOutput し、 pooled stack の
# runtime-config に cross-stack ref として焼かれる。 一方 SBT pipeline (CodeBuild) はこの env を
# 持たないため synth 時に `enableParticipantPortal=false` に倒れ、 pooled stack を update する
# たびに runtime-config から `participantPortalUrl` が **silent に消える** (= user 観測
# 「participantPortalUrl 未注入」)。 install.sh と同じ default を CodeBuild にも入れて、
# tenant provisioning / update での regression を防ぐ。
export CDK_PARAM_ENABLE_PARTICIPANT_PORTAL="true"
echo "CDK_PARAM_ENABLE_PARTICIPANT_PORTAL: ${CDK_PARAM_ENABLE_PARTICIPANT_PORTAL}"

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

# SBT の Step Functions provisioning が同 pooled stack へ並列 deploy を試みると CDK が
# race し、 後続 build が次の 2 種の failure を起こす:
#   1. Cannot delete ChangeSet in status CREATE_IN_PROGRESS (= 先行 build の ChangeSet
#      がまだ作成中で、 後続が削除できない)
#   2. Stack ... is in UPDATE_IN_PROGRESS state and can not be updated (= 先行 deploy が
#      ChangeSet を execute 中で、 stack が次の update を受け付けない)
# cdk deploy 直前に stack を idle 状態 (= *_COMPLETE / *_FAILED 等の terminal) まで poll
# する。 stack が存在しない初回 create は MISSING 扱いで即 return (= cdk deploy が作る)。
wait_for_stack_idle() {
  local stack="$1"
  local max_wait=900  # 15 min: 既存 CFn deploy の典型最長 (= LambdaFunction + UserPool 等)
  local waited=0
  while [ "${waited}" -lt "${max_wait}" ]; do
    local status
    status=$(aws cloudformation describe-stacks --stack-name "${stack}" \
      --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo "MISSING")
    case "${status}" in
      MISSING)
        echo "[wait_for_stack_idle] stack ${stack} not yet created (= 初回 cdk deploy で作成される)"
        return 0
        ;;
      *_IN_PROGRESS)
        echo "[wait_for_stack_idle] stack ${stack} busy (status=${status}), 15s 後 retry (累計 ${waited}s)"
        sleep 15
        waited=$((waited + 15))
        ;;
      *)
        echo "[wait_for_stack_idle] stack ${stack} idle (status=${status})"
        return 0
        ;;
    esac
  done
  echo "[wait_for_stack_idle] ERROR: stack ${stack} が ${max_wait}s 経っても busy。 並列 provisioning 同士の競合を operator が手動で解消してください"
  return 1
}

wait_for_stack_idle "${STACK_NAME}"
# provision-tenant.sh と同じ理由: synth は app 全体を構築するため、 絞らないと deploy 対象外の
# ControlPlaneStack の Python Lambda まで CodeBuild 上で Docker build しに行って落ちる。
# `--exclusively` は既に付いているので stub asset が他 stack へ流れる心配はない。
export CDK_BUNDLING_STACKS="${STACK_NAME}"
bun run cdk -- deploy "${STACK_NAME}" --exclusively --require-approval never
