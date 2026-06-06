#!/usr/bin/env bash
#
# publish-launch-template.sh
# --------------------------
# Mirror the Lite-mode Launch Stack template to a public Amazon S3 bucket so the
# README "Launch Stack" button (a CloudFormation quick-create link) can fetch it.
#
# Why this exists: CloudFormation only accepts an Amazon S3 URL for a quick-create
# / create-stack `templateURL`. A raw.githubusercontent.com URL is rejected with
# "TemplateURL must be a supported URL." The template's source of truth stays in
# this repo (infrastructure/templates/lite-pipeline.yaml); this script publishes a
# copy to S3 and prints (and can write) the working one-click button URL.
#
# Cost: the object is a few KB of YAML. Public-read S3 storage of one small file
# is effectively zero (well inside the Free Tier), in line with the cost-zero
# principle. The template is public IaC already visible on GitHub, so public-read
# exposes nothing new; the bucket policy is scoped to the single template object.
#
# Usage:
#   bun run / make publish-launch-template
#   scripts/publish-launch-template.sh [--bucket NAME] [--region REGION]
#                                      [--no-ensure-bucket] [--write-readme]
#
# Environment overrides:
#   LAUNCH_TEMPLATE_BUCKET   target bucket (default: tenkacloud-launch-<account>-<region>)
#   LAUNCH_TEMPLATE_REGION   target region (default: $AWS_REGION or ap-northeast-1)
#   LAUNCH_TEMPLATE_PATH     template path (default: infrastructure/templates/lite-pipeline.yaml)
#   LAUNCH_STACK_NAME        default stack name baked into the link (default: tenkacloud-lite-pipeline)
#
set -euo pipefail

REGION="${LAUNCH_TEMPLATE_REGION:-${AWS_REGION:-ap-northeast-1}}"
TEMPLATE_PATH="${LAUNCH_TEMPLATE_PATH:-infrastructure/templates/lite-pipeline.yaml}"
STACK_NAME="${LAUNCH_STACK_NAME:-tenkacloud-lite-pipeline}"
BUCKET="${LAUNCH_TEMPLATE_BUCKET:-}"
ENSURE_BUCKET=true
WRITE_README=false
README_PATH="README.md"

while [ $# -gt 0 ]; do
  case "$1" in
    --bucket) BUCKET="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --template) TEMPLATE_PATH="$2"; shift 2 ;;
    --stack-name) STACK_NAME="$2"; shift 2 ;;
    --no-ensure-bucket) ENSURE_BUCKET=false; shift ;;
    --write-readme) WRITE_README=true; shift ;;
    -h|--help)
      sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

log() { printf '\033[1;34m[publish-launch-template]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[publish-launch-template] %s\033[0m\n' "$*" >&2; exit 1; }

command -v aws >/dev/null 2>&1 || die "aws CLI not found. Install it and configure credentials first."
[ -f "$TEMPLATE_PATH" ] || die "template not found: $TEMPLATE_PATH (run from the repo root)."

KEY="$(basename "$TEMPLATE_PATH")"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text 2>/dev/null)" \
  || die "could not resolve AWS account. Are your credentials configured? (aws configure / SSO)"

if [ -z "$BUCKET" ]; then
  BUCKET="tenkacloud-launch-${ACCOUNT_ID}-${REGION}"
fi

log "account=${ACCOUNT_ID} region=${REGION}"
log "bucket=${BUCKET} key=${KEY}"

if aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  log "bucket exists."
elif [ "$ENSURE_BUCKET" = true ]; then
  log "creating bucket ${BUCKET} ..."
  if [ "$REGION" = "us-east-1" ]; then
    aws s3api create-bucket --bucket "$BUCKET" >/dev/null
  else
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
      --create-bucket-configuration "LocationConstraint=${REGION}" >/dev/null
  fi
  # Allow a policy-based public read while keeping public ACLs blocked.
  aws s3api put-public-access-block --bucket "$BUCKET" \
    --public-access-block-configuration \
    "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=false,RestrictPublicBuckets=false" >/dev/null
  # Public read scoped to the single template object only.
  aws s3api put-bucket-policy --bucket "$BUCKET" --policy "$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PublicReadLaunchTemplate",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::${BUCKET}/${KEY}"
    }
  ]
}
JSON
)" >/dev/null
  log "bucket created with public-read scoped to ${KEY}."
else
  die "bucket ${BUCKET} not found and --no-ensure-bucket was set."
fi

log "uploading ${TEMPLATE_PATH} ..."
aws s3api put-object --bucket "$BUCKET" --key "$KEY" \
  --body "$TEMPLATE_PATH" --content-type "text/yaml" >/dev/null

TEMPLATE_URL="https://${BUCKET}.s3.${REGION}.amazonaws.com/${KEY}"
LAUNCH_URL="https://console.aws.amazon.com/cloudformation/home?region=${REGION}#/stacks/quickcreate?templateURL=${TEMPLATE_URL}&stackName=${STACK_NAME}"

printf '\n'
log "Template published:"
printf '  %s\n' "$TEMPLATE_URL"
log "Launch Stack URL (paste into the README button href):"
printf '  %s\n\n' "$LAUNCH_URL"

if [ "$WRITE_README" = true ]; then
  [ -f "$README_PATH" ] || die "README not found at ${README_PATH}"
  # Replace the templateURL inside the existing Launch Stack button link.
  tmp="$(mktemp)"
  # Rewrite the existing "[![Launch Stack](...)](...)" line in place, wherever it is.
  awk -v url="$LAUNCH_URL" '
    /^\[!\[Launch Stack\]\(/ { print "[![Launch Stack](https://s3.amazonaws.com/cloudformation-examples/cloudformation-launch-stack.png)](" url ")"; next }
    { print }
  ' "$README_PATH" > "$tmp" && mv "$tmp" "$README_PATH"
  log "README button updated. Review and commit ${README_PATH}."
fi

log "Done."
