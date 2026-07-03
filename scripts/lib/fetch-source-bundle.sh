# Shared source-bundle fetch preamble for the tenant provision/deprovision
# ScriptJobs (#2217). This is INLINED at synth time into both scripts by
# `composeTenantScript` in bootstrap-template-stack.ts — it CANNOT be `source`d at
# runtime, because this fetch is what downloads the source bundle that would
# contain it (chicken-and-egg; unlike install-node.sh, which is sourced AFTER the
# unzip below). Keep it dependency-free and side-effect-only.

export REGION=$AWS_REGION
echo "REGION: ${REGION}"

# Split assignment from export so a failed/expired STS call is not masked by
# export's own success (SC2155) — fail loud on bad credentials.
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export ACCOUNT_ID
echo "ACCOUNT_ID: ${ACCOUNT_ID}"

# Download serverless reference solution from S3 bucket.
# #2194: CDK_PARAM_S3_BUCKET_NAME is injected by the ScriptJob env with the resolved
# (per-environment) bucket name the deploy created. Do NOT recompute it here — the
# old local recompute diverged from the real hashed name, so provisioning read a
# non-existent bucket. Fail loud if it is missing.
if [ -z "${CDK_PARAM_S3_BUCKET_NAME:-}" ]; then
  echo "ERROR: CDK_PARAM_S3_BUCKET_NAME is not set (expected from the ScriptJob env)" >&2
  exit 1
fi
echo "CDK_PARAM_S3_BUCKET_NAME: ${CDK_PARAM_S3_BUCKET_NAME}"
export CDK_SOURCE_NAME="source.zip"

VERSIONS=$(aws s3api list-object-versions --bucket "$CDK_PARAM_S3_BUCKET_NAME" --prefix "$CDK_SOURCE_NAME" --query 'Versions[?IsLatest==`true`].{VersionId:VersionId}' --output text 2>&1)
CDK_PARAM_COMMIT_ID=$(echo "$VERSIONS" | awk 'NR==1{print $1}')
echo "CDK_PARAM_COMMIT_ID: ${CDK_PARAM_COMMIT_ID}"

aws s3api get-object --bucket "$CDK_PARAM_S3_BUCKET_NAME" --key "$CDK_SOURCE_NAME" --version-id "$CDK_PARAM_COMMIT_ID" "$CDK_SOURCE_NAME" 2>&1
# `-o`: silent overwrite (CodeBuild workspace reuse — a prompt would EOF to `[N]one`
# and leave an incomplete tree that silently fails downstream).
unzip -o "$CDK_SOURCE_NAME"
