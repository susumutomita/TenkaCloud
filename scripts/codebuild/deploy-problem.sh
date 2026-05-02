#!/bin/bash
# Problem deploy CodeBuild script — runs inside CodeBuild after EventBridge
# routes a ProblemDeployRequested event here. Dispatches based on $ACTION:
#   deploy   : 新規 stack (CreateStack)
#   redeploy : 既存 failed/rollback stack を消してから create
#   teardown : delete-stack (event 終了後の resource 解放)
#
# 必須 env (EventBridge input transformer から流し込む):
#   ACTION              "deploy"|"redeploy"|"teardown"
#   PROBLEM_ID          DynamoDB / log 用
#   TEAM_ID             competitor account の id (= DynamoDB SK)
#   EVENT_ID            イベント ID
#   JOB_ID              GameDayDeploymentJob の ID
#   TARGET_ROLE_ARN     team account の cross-account role
#   EXTERNAL_ID         Confused Deputy 防止用
#   TEMPLATE_URL        CFn テンプレートの S3 URL (deploy/redeploy のみ)
#   STACK_NAME          target account 内での stack 名
#   STACK_REGION        deploy 先 region
#   EVENT_BUS_NAME      完了イベントを返す bus
#   ACCOUNT_ID          target account ID (CFn validation 等で使う)
#
# 終了時に PROBLEM_DEPLOY_COMPLETED または PROBLEM_DEPLOY_FAILED を
# EventBus に publish する。dispatch 側は SBT と同じ pattern。

set -euo pipefail

ACTION="${ACTION:-deploy}"
DEPLOYMENT_KEY="${EVENT_ID}:${PROBLEM_ID}:${JOB_ID}"

log() { echo "[deploy-problem] [$(date +%H:%M:%S)] $*"; }
fail() { log "FAIL: $*"; emit_outcome "failed" "$*"; exit 1; }

emit_outcome() {
  local status="$1"
  local reason="${2:-}"
  local detail_type
  if [[ "$status" == "completed" ]]; then
    detail_type="problem.deploy.completed"
  else
    detail_type="problem.deploy.failed"
  fi
  local payload
  payload=$(jq -n \
    --arg key "$DEPLOYMENT_KEY" \
    --arg status "$status" \
    --arg stackName "${STACK_NAME:-}" \
    --arg stackId "${STACK_ID:-}" \
    --arg reason "$reason" \
    '{ deploymentKey: $key, jobOutput: { tenantData: { deployStatus: $status, stackName: $stackName, stackId: $stackId, errorReason: $reason } } }')
  aws events put-events --entries "[{
    \"Source\": \"tenkacloud.problem-service\",
    \"DetailType\": \"${detail_type}\",
    \"EventBusName\": \"${EVENT_BUS_NAME}\",
    \"Detail\": $(echo "$payload" | jq -Rs .)
  }]" >/dev/null || log "WARN: put-events failed (continuing)"
}

assume_target_role() {
  log "AssumeRole into ${TARGET_ROLE_ARN} (externalId=${EXTERNAL_ID})"
  local creds
  creds=$(aws sts assume-role \
    --role-arn "${TARGET_ROLE_ARN}" \
    --role-session-name "tenkacloud-${EVENT_ID:0:32}" \
    --external-id "${EXTERNAL_ID}" \
    --duration-seconds 3600 \
    --output json) || fail "AssumeRole failed"
  export AWS_ACCESS_KEY_ID
  export AWS_SECRET_ACCESS_KEY
  export AWS_SESSION_TOKEN
  AWS_ACCESS_KEY_ID=$(jq -r '.Credentials.AccessKeyId' <<<"$creds")
  AWS_SECRET_ACCESS_KEY=$(jq -r '.Credentials.SecretAccessKey' <<<"$creds")
  AWS_SESSION_TOKEN=$(jq -r '.Credentials.SessionToken' <<<"$creds")
}

stack_exists() {
  aws cloudformation describe-stacks \
    --stack-name "${STACK_NAME}" \
    --region "${STACK_REGION}" \
    >/dev/null 2>&1
}

stack_status() {
  aws cloudformation describe-stacks \
    --stack-name "${STACK_NAME}" \
    --region "${STACK_REGION}" \
    --query 'Stacks[0].StackStatus' \
    --output text 2>/dev/null
}

wait_for_create() {
  log "wait stack-create-complete: ${STACK_NAME}"
  aws cloudformation wait stack-create-complete \
    --stack-name "${STACK_NAME}" \
    --region "${STACK_REGION}" \
    || fail "stack-create wait failed (status=$(stack_status || echo unknown))"
}

wait_for_delete() {
  log "wait stack-delete-complete: ${STACK_NAME}"
  aws cloudformation wait stack-delete-complete \
    --stack-name "${STACK_NAME}" \
    --region "${STACK_REGION}" \
    || fail "stack-delete wait failed"
}

do_create() {
  log "create-stack ${STACK_NAME} from ${TEMPLATE_URL}"
  local result
  result=$(aws cloudformation create-stack \
    --stack-name "${STACK_NAME}" \
    --region "${STACK_REGION}" \
    --template-url "${TEMPLATE_URL}" \
    --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM CAPABILITY_AUTO_EXPAND \
    --on-failure ROLLBACK \
    --tags \
      Key=tenkacloud:problem-id,Value="${PROBLEM_ID}" \
      Key=tenkacloud:team-id,Value="${TEAM_ID}" \
      Key=tenkacloud:event-id,Value="${EVENT_ID}" \
      Key=tenkacloud:managed-by,Value=tenkacloud-deploy-pipeline \
    --output json) || fail "create-stack failed"
  STACK_ID=$(jq -r '.StackId' <<<"$result")
  export STACK_ID
  wait_for_create
}

do_delete() {
  log "delete-stack ${STACK_NAME}"
  aws cloudformation delete-stack \
    --stack-name "${STACK_NAME}" \
    --region "${STACK_REGION}" || fail "delete-stack failed"
  wait_for_delete
}

main() {
  log "ACTION=${ACTION} PROBLEM_ID=${PROBLEM_ID} TEAM_ID=${TEAM_ID} STACK=${STACK_NAME}"
  assume_target_role

  case "$ACTION" in
    deploy)
      if stack_exists; then
        fail "stack already exists; use ACTION=redeploy to recreate"
      fi
      do_create
      ;;
    redeploy)
      if stack_exists; then
        log "existing stack status: $(stack_status)"
        do_delete
      fi
      do_create
      ;;
    teardown)
      if stack_exists; then
        do_delete
      else
        log "stack not found; nothing to teardown"
      fi
      ;;
    *)
      fail "unknown ACTION: ${ACTION}"
      ;;
  esac

  emit_outcome "completed"
  log "OK"
}

main "$@"
