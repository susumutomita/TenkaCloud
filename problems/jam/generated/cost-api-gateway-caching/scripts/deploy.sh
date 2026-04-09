#!/bin/bash
# Deploy this problem's CloudFormation stack
#
# Usage:
#   STACK_NAME=my-stack ./scripts/deploy.sh
#   AWS_REGION=ap-northeast-1 STACK_NAME=my-stack ./scripts/deploy.sh
#
# Environment variables:
#   STACK_NAME   CloudFormation stack name (default: problem directory name)
#   AWS_REGION   AWS region (default: us-east-1)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROBLEM_DIR="$(dirname "$SCRIPT_DIR")"
PROBLEM_NAME="$(basename "$PROBLEM_DIR")"

STACK_NAME="${STACK_NAME:-$PROBLEM_NAME}"
AWS_REGION="${AWS_REGION:-us-east-1}"

CFN_TEMPLATE=$(ls "$PROBLEM_DIR"/cloudformation/*.yaml 2>/dev/null | head -1)

if [[ -z "$CFN_TEMPLATE" ]]; then
  echo "Error: No CloudFormation template found in $PROBLEM_DIR/cloudformation/"
  exit 1
fi

echo "Deploying: $PROBLEM_NAME → stack: $STACK_NAME (region: $AWS_REGION)"
echo "Template : $CFN_TEMPLATE"
echo ""

aws cloudformation deploy \
  --template-file "$CFN_TEMPLATE" \
  --stack-name "$STACK_NAME" \
  --capabilities CAPABILITY_NAMED_IAM CAPABILITY_AUTO_EXPAND \
  --region "$AWS_REGION"

echo ""
echo "✓ Stack deployed: $STACK_NAME"
aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$AWS_REGION" \
  --query "Stacks[0].Outputs" \
  --output table 2>/dev/null || true
