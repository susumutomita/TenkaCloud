#!/usr/bin/env bash
# delete-battles.sh — 1 引数 (StackName) を受け取って CFn DeleteStack + Wait する。
#
# Usage:
#   bash scripts/delete-battles.sh <stack-name-or-arn> [<region>]
#
# 環境変数:
#   AWS_REGION    region。第 2 引数 / env / aws cli config の順で解決
#
# 設計意図:
#   deploy-battles.sh と対称な操作。MVP-1 は same-account なので CodeBuild Project Role
#   が直接 CFn DeleteStack 権限を持つ。Phase 2 (cross-account) では sts:AssumeRole に
#   差し替える。
#
# ステータス:
#   - Stack が存在しない (Already Deleted) → 0 で正常終了
#   - DeleteStack 後 wait failed → 非 0 で終了 (State Machine 側 MarkFailed が拾う)

set -euo pipefail

case "${LC_ALL:-${LANG:-}}" in
  C|POSIX|"")
    export LANG="en_US.UTF-8"
    export LC_ALL="en_US.UTF-8"
    ;;
esac

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <stack-name-or-arn> [<region>]" >&2
  exit 1
fi

STACK_NAME="$1"
REGION="${2:-${AWS_REGION:-$(aws configure get region 2>/dev/null || true)}}"

if [[ -z "${REGION}" ]]; then
  echo "error: AWS region が解決できません (引数 / AWS_REGION env / aws cli config の順で探した)" >&2
  exit 1
fi

echo "=========================================="
echo "Deleting stack"
echo "  StackName : ${STACK_NAME}"
echo "  Region    : ${REGION}"
echo "=========================================="

# Stack 存在確認。既に削除済み (DescribeStacks が ValidationError) なら何もせず終了する。
if ! aws cloudformation describe-stacks \
    --region "${REGION}" \
    --stack-name "${STACK_NAME}" \
    --query "Stacks[0].StackStatus" \
    --output text >/dev/null 2>&1; then
  echo "Stack ${STACK_NAME} は既に存在しない (already deleted) → no-op で終了"
  exit 0
fi

aws cloudformation delete-stack \
  --region "${REGION}" \
  --stack-name "${STACK_NAME}"

# DeleteStack は async。完了 (= DescribeStacks が ValidationError を返す) まで wait。
# 60 minutes timeout (CodeBuild Project の build timeout と揃える)。
aws cloudformation wait stack-delete-complete \
  --region "${REGION}" \
  --stack-name "${STACK_NAME}"

echo ""
echo "Stack ${STACK_NAME} deleted (region=${REGION})."
