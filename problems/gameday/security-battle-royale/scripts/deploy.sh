#!/bin/bash
# Deploy script for Security Battle Royale
#
# Usage:
#   TEAMS="team01 team02 team03" ./scripts/deploy.sh
#
# Environment variables:
#   TEAMS       Space-separated team names (default: team01)
#   BUCKET      S3 source code bucket name (auto-detected if omitted)
#   AWS_REGION  AWS region (default: us-east-1)
#   VPC_ID      VPC ID for CloudFormation (required if deploying stacks)
#   SUBNET1     First public subnet ID (required if deploying stacks)
#   SUBNET2     Second public subnet ID (required if deploying stacks)
#   DB_PASSWORD DB password (default: adminadmin)
#   SKIP_CFN    Set to 1 to skip CloudFormation deployment (just upload code)

set -euo pipefail

TEAMS=${TEAMS:-"team01"}
AWS_REGION=${AWS_REGION:-"us-east-1"}
DB_PASSWORD=${DB_PASSWORD:-"adminadmin"}
SKIP_CFN=${SKIP_CFN:-"0"}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROBLEM_DIR="$(dirname "$SCRIPT_DIR")"
CFN_TEMPLATE="$PROBLEM_DIR/cloudformation/team-stack.yaml"
API_DIR="$PROBLEM_DIR/api"
FRONTEND_DIR="$PROBLEM_DIR/frontend"
BUILD_DIR="$PROBLEM_DIR/build"

echo "======================================================"
echo "  Security Battle Royale — Deploy"
echo "======================================================"
echo "  Teams   : $TEAMS"
echo "  Region  : $AWS_REGION"
echo "======================================================"

# ── Step 1: Find source code bucket ──────────────────────
if [[ -z "${BUCKET:-}" ]]; then
  BUCKET=$(aws s3 ls | grep applicationsourcecode | awk '{print $3}' | head -1)
fi

if [[ -z "${BUCKET:-}" ]]; then
  echo ""
  echo "Error: No applicationsourcecode bucket found."
  echo "  Set BUCKET env var or create the bucket first:"
  echo "  aws s3 mb s3://tenkacloud-gameday-applicationsourcecode-\$(aws sts get-caller-identity --query Account --output text)"
  exit 1
fi

echo ""
echo "=== [1/3] Packaging Flask API → s3://$BUCKET/flask_api.zip ==="
mkdir -p "$BUILD_DIR"
(
  cd "$PROBLEM_DIR"
  zip -r "$BUILD_DIR/flask_api.zip" api/ \
    -x "*/build/*" "*/__pycache__/*" "*.pyc" "*.git*"
)
aws s3 cp "$BUILD_DIR/flask_api.zip" "s3://$BUCKET/flask_api.zip" \
  --region "$AWS_REGION"
echo "✓ Uploaded flask_api.zip"

# ── Step 2: Deploy CloudFormation stacks (one per team) ──
if [[ "$SKIP_CFN" == "1" ]]; then
  echo ""
  echo "=== [2/3] Skipping CloudFormation (SKIP_CFN=1) ==="
else
  : "${VPC_ID:?VPC_ID is required. Set: export VPC_ID=vpc-xxxx}"
  : "${SUBNET1:?SUBNET1 is required. Set: export SUBNET1=subnet-xxxx}"
  : "${SUBNET2:?SUBNET2 is required. Set: export SUBNET2=subnet-yyyy}"

  echo ""
  echo "=== [2/3] Deploying CloudFormation stacks ==="

  for TEAM in $TEAMS; do
    STACK_NAME="UnicornRentals-${TEAM}"
    echo ""
    echo "  → $STACK_NAME ..."

    # Check if stack already exists
    STACK_STATUS=$(aws cloudformation describe-stacks \
      --stack-name "$STACK_NAME" \
      --region "$AWS_REGION" \
      --query 'Stacks[0].StackStatus' \
      --output text 2>/dev/null || echo "DOES_NOT_EXIST")

    CFN_ACTION="create-stack"
    if [[ "$STACK_STATUS" != "DOES_NOT_EXIST" && "$STACK_STATUS" != "ROLLBACK_COMPLETE" ]]; then
      CFN_ACTION="update-stack"
    fi

    aws cloudformation "$CFN_ACTION" \
      --stack-name "$STACK_NAME" \
      --template-body "file://$CFN_TEMPLATE" \
      --parameters \
        ParameterKey=TeamName,ParameterValue="$TEAM" \
        ParameterKey=SourceCodeBucket,ParameterValue="$BUCKET" \
        ParameterKey=DBPassword,ParameterValue="$DB_PASSWORD" \
        ParameterKey=VpcId,ParameterValue="$VPC_ID" \
        ParameterKey=PublicSubnet1,ParameterValue="$SUBNET1" \
        ParameterKey=PublicSubnet2,ParameterValue="$SUBNET2" \
      --capabilities CAPABILITY_NAMED_IAM \
      --region "$AWS_REGION" \
      --output text 2>&1 || {
        # update-stack returns "No updates are to be performed" — that's ok
        echo "  (no changes)"
      }

    echo "  Waiting for stack to complete..."
    aws cloudformation wait "stack-${CFN_ACTION%-stack}-complete" \
      --stack-name "$STACK_NAME" \
      --region "$AWS_REGION" 2>/dev/null || true

    echo "  ✓ $STACK_NAME done"
  done
fi

# ── Step 3: Upload frontend & show results ────────────────
echo ""
echo "=== [3/3] Uploading frontend & showing outputs ==="

for TEAM in $TEAMS; do
  STACK_NAME="UnicornRentals-${TEAM}"
  WEBSITE_BUCKET="unicornrentals-website-${TEAM}"

  # Upload index.html
  if aws s3 ls "s3://$WEBSITE_BUCKET" >/dev/null 2>&1; then
    aws s3 cp "$FRONTEND_DIR/index.html" "s3://$WEBSITE_BUCKET/index.html" \
      --content-type "text/html" \
      --cache-control "no-cache" \
      --region "$AWS_REGION"
    echo "  ✓ $TEAM: index.html → s3://$WEBSITE_BUCKET"
  else
    echo "  ⚠ $TEAM: bucket s3://$WEBSITE_BUCKET not found (stack may not be ready)"
  fi

  # Show stack outputs
  OUTPUTS=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --region "$AWS_REGION" \
    --query 'Stacks[0].Outputs' \
    --output table 2>/dev/null || echo "(stack not found)")
  echo ""
  echo "  $STACK_NAME outputs:"
  echo "$OUTPUTS" | sed 's/^/    /'
done

echo ""
echo "======================================================"
echo "  Deploy complete!"
echo "======================================================"
echo ""
echo "  Verification commands:"
for TEAM in $TEAMS; do
  STACK_NAME="UnicornRentals-${TEAM}"
  API_IP=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" --region "$AWS_REGION" \
    --query 'Stacks[0].Outputs[?OutputKey==`APIPublicIP`].OutputValue' \
    --output text 2>/dev/null || echo "N/A")
  echo "  curl http://$API_IP/api/v1/apistatus  # $TEAM"
done
echo ""
