#!/usr/bin/env bash
# Prepare the cloud host's CodeBuild source object. Can be sourced to export the
# resolved CDK inputs or executed before deployment. Resolution is read-only.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TENKACLOUD_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=lib/names.sh
source "${SCRIPT_DIR}/lib/names.sh"
REGION="${REGION:-${AWS_REGION:-${AWS_DEFAULT_REGION:-}}}"
if [ -z "${REGION}" ]; then
  REGION="$(aws configure get region || true)"
fi
if ! [[ "${REGION}" =~ ^[a-z]{2}(-[a-z]+)+-[0-9]+$ ]]; then
  echo "[prepare-source-bundle] ERROR: REGION / ACCOUNT_ID を解決できません。 Set an AWS region and configure the AWS CLI." >&2
  exit 1
fi
# AWS_PROFILE is inherited by every call. Explicit --region prevents an ambient
# profile default from routing bucket operations to a different region.
export AWS_REGION="${REGION}" AWS_DEFAULT_REGION="${REGION}"
RESOLVED_ACCOUNT_ID="$(aws sts get-caller-identity --region "${REGION}" --query Account --output text)"
if ! [[ "${RESOLVED_ACCOUNT_ID}" =~ ^[0-9]{12}$ ]]; then
  echo "[prepare-source-bundle] ERROR: AWS caller did not return a valid account ID" >&2
  exit 1
fi
if [ -n "${ACCOUNT_ID:-}" ] && [ "${ACCOUNT_ID}" != "${RESOLVED_ACCOUNT_ID}" ]; then
  echo "[prepare-source-bundle] ERROR: ACCOUNT_ID does not match the active AWS profile" >&2
  exit 1
fi
ACCOUNT_ID="${RESOLVED_ACCOUNT_ID}"
ENV="${ENV:-development}"
if ! [[ "${ENV}" =~ ^[A-Za-z0-9][A-Za-z0-9_-]*$ ]]; then
  echo "[prepare-source-bundle] ERROR: invalid environment name" >&2
  exit 1
fi
LEGACY_BUCKET="$(tc_source_bucket_legacy_name "${ACCOUNT_ID}" "${REGION}")"
if [ -z "${CDK_PARAM_S3_BUCKET_NAME:-}" ] \
  || [ "${CDK_PARAM_S3_BUCKET_NAME}" = "tenkacloud-source-placeholder" ] \
  || [ "${CDK_PARAM_S3_BUCKET_NAME}" = "${LEGACY_BUCKET}" ]; then
  CDK_PARAM_S3_BUCKET_NAME="$(tc_source_bucket_name "${ACCOUNT_ID}" "${REGION}" "${ENV}")"
fi
CDK_SOURCE_NAME="${CDK_SOURCE_NAME:-source.zip}"
if ! [[ "${CDK_PARAM_S3_BUCKET_NAME}" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] \
  || [[ "${CDK_PARAM_S3_BUCKET_NAME}" = *..* ]] \
  || ! [[ "${CDK_SOURCE_NAME}" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]{0,1023}$ ]] \
  || [[ "${CDK_SOURCE_NAME}" =~ (^|/)\.\.?(/|$) ]]; then
  echo "[prepare-source-bundle] ERROR: invalid source bucket or object key" >&2
  exit 1
fi
export CDK_PARAM_S3_BUCKET_NAME CDK_SOURCE_NAME
if [ "${PREPARE_SOURCE_BUNDLE_RESOLVE_ONLY:-}" = "1" ]; then
  printf 'REGION=%s\nACCOUNT_ID=%s\nCDK_PARAM_S3_BUCKET_NAME=%s\nCDK_SOURCE_NAME=%s\n' \
    "${REGION}" "${ACCOUNT_ID}" "${CDK_PARAM_S3_BUCKET_NAME}" "${CDK_SOURCE_NAME}"
  if [ "${BASH_SOURCE[0]}" != "$0" ]; then return 0; else exit 0; fi
fi

if [ "${SOURCE_BUNDLE_PIN_EXECUTION:-}" = "1" ] && [ "${#CDK_SOURCE_NAME}" -gt 972 ]; then
  echo "[prepare-source-bundle] ERROR: source object namespace is too long for a pinned execution archive" >&2
  exit 1
fi

# Pinned competition execution requires a real object version. Reject an explicit
# suspended setting before local builds or any bucket mutation.
case "$(printf '%s' "${CDK_PARAM_SOURCE_BUCKET_VERSIONING:-}" | tr '[:upper:]' '[:lower:]')" in
  false | suspended | 0)
    if [ "${SOURCE_BUNDLE_PIN_EXECUTION:-}" = "1" ]; then
    echo "[prepare-source-bundle] ERROR: Cloud execution pins require source bucket versioning. Remove CDK_PARAM_SOURCE_BUCKET_VERSIONING=false/suspended/0 before deploying." >&2
    exit 1
    fi ;;
esac

export SOURCE_BUNDLE_ROOT="${TENKACLOUD_ROOT}"
export SOURCE_BUNDLE_WORK_DIR="${SOURCE_BUNDLE_WORK_DIR:-${TENKACLOUD_ROOT}/.cache/source-bundle}"
# Object keys may include prefixes; the local archive has an independent path.
export SOURCE_BUNDLE_ARCHIVE_PATH="${SOURCE_BUNDLE_ARCHIVE_PATH:-${SOURCE_BUNDLE_WORK_DIR}/source.zip}"
SOURCE_BUNDLE_VALIDATE_ONLY=1 bash "${SCRIPT_DIR}/package-source-bundle.sh"
cleanup_source_bundle_work_dir() {
  SOURCE_BUNDLE_CLEANUP_ONLY=1 bash "${SCRIPT_DIR}/package-source-bundle.sh"
}
trap cleanup_source_bundle_work_dir EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Complete validation and local work before changing any remote resources.
LIFECYCLE_JSON="$(bun --no-env-file run "${SCRIPT_DIR}/ops/print-source-bundle-lifecycle.ts" "${ENV}")"
echo "[prepare-source-bundle] ensuring problems/ submodule is initialized..."
(cd "${TENKACLOUD_ROOT}" && git submodule update --init --recursive problems)
for app in application-admin-console participant-portal; do
  echo "[prepare-source-bundle] building apps/${app}..."
  (cd "${TENKACLOUD_ROOT}/apps/${app}" && bun --no-env-file run build)
done
bash "${SCRIPT_DIR}/package-source-bundle.sh"

echo "[prepare-source-bundle] bucket=${CDK_PARAM_S3_BUCKET_NAME} key=${CDK_SOURCE_NAME}"
if aws s3api head-bucket --bucket "${CDK_PARAM_S3_BUCKET_NAME}" \
  --expected-bucket-owner "${ACCOUNT_ID}" --region "${REGION}" 2>/dev/null; then
  echo "[prepare-source-bundle] using existing source bucket"
else
  if [ "${REGION}" = "us-east-1" ]; then
    aws s3api create-bucket --bucket "${CDK_PARAM_S3_BUCKET_NAME}" --region "${REGION}"
  else
    aws s3api create-bucket --bucket "${CDK_PARAM_S3_BUCKET_NAME}" --region "${REGION}" \
      --create-bucket-configuration LocationConstraint="${REGION}"
  fi
fi
# Apply privacy and retention to existing buckets too. The expected owner guard
# prevents mutations if a custom bucket belongs to a different account.
aws s3api put-public-access-block --bucket "${CDK_PARAM_S3_BUCKET_NAME}" \
  --expected-bucket-owner "${ACCOUNT_ID}" --region "${REGION}" \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
case "$(printf '%s' "${CDK_PARAM_SOURCE_BUCKET_VERSIONING:-}" | tr '[:upper:]' '[:lower:]')" in
  false | suspended | 0) VERSIONING_STATUS="Suspended" ;;
  *) VERSIONING_STATUS="Enabled" ;;
esac
aws s3api put-bucket-versioning --bucket "${CDK_PARAM_S3_BUCKET_NAME}" \
  --expected-bucket-owner "${ACCOUNT_ID}" --region "${REGION}" \
  --versioning-configuration "Status=${VERSIONING_STATUS}"
aws s3api put-bucket-lifecycle-configuration --bucket "${CDK_PARAM_S3_BUCKET_NAME}" \
  --expected-bucket-owner "${ACCOUNT_ID}" --region "${REGION}" \
  --lifecycle-configuration "${LIFECYCLE_JSON}"
# A fresh key never becomes noncurrent after a later platform update, so the
# existing noncurrent-version lifecycle cannot expire a running event's archive.
# Keep the caller's configured key as a namespace; explicit source-bucket cleanup
# removes these archives together with their versions after the event.
if [ "${SOURCE_BUNDLE_PIN_EXECUTION:-}" = "1" ]; then
SOURCE_EXECUTION_ID="$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
CDK_SOURCE_NAME="${CDK_SOURCE_NAME}.executions/${SOURCE_EXECUTION_ID}.zip"
SOURCE_UPLOAD_RECEIPT="$(aws s3api put-object --bucket "${CDK_PARAM_S3_BUCKET_NAME}" \
  --expected-bucket-owner "${ACCOUNT_ID}" --region "${REGION}" \
  --key "${CDK_SOURCE_NAME}" --body "${SOURCE_BUNDLE_ARCHIVE_PATH}" \
  --if-none-match '*' --query '[ETag,VersionId]' --output text)"
IFS=$'\t' read -r CDK_PARAM_COMMIT_ID CDK_SOURCE_VERSION_ID <<< "${SOURCE_UPLOAD_RECEIPT}"
if ! [[ "${CDK_PARAM_COMMIT_ID}" =~ ^\"?[a-fA-F0-9]{32}(-[0-9]+)?\"?$ ]] \
  || [ -z "${CDK_SOURCE_VERSION_ID:-}" ] || [ "${CDK_SOURCE_VERSION_ID}" = "None" ] \
  || [ "${CDK_SOURCE_VERSION_ID}" = "null" ]; then
  echo "[prepare-source-bundle] ERROR: source upload returned no valid ETag and VersionId; deployment stopped" >&2
  exit 1
fi
else
  CDK_PARAM_COMMIT_ID="$(aws s3api put-object --bucket "${CDK_PARAM_S3_BUCKET_NAME}" \
    --expected-bucket-owner "${ACCOUNT_ID}" --region "${REGION}" \
    --key "${CDK_SOURCE_NAME}" --body "${SOURCE_BUNDLE_ARCHIVE_PATH}" --query ETag --output text)"
  if [ -z "${CDK_PARAM_COMMIT_ID}" ] || [ "${CDK_PARAM_COMMIT_ID}" = "None" ]; then
    echo "[prepare-source-bundle] ERROR: source upload returned no ETag" >&2
    exit 1
  fi
  CDK_SOURCE_VERSION_ID=""
fi
export CDK_PARAM_COMMIT_ID CDK_SOURCE_VERSION_ID CDK_SOURCE_NAME
printf 'SOURCE_UPLOAD_KEY=%s\nSOURCE_UPLOAD_ETAG=%s\nSOURCE_UPLOAD_VERSION_ID=%s\n' \
  "${CDK_SOURCE_NAME}" "${CDK_PARAM_COMMIT_ID}" "${CDK_SOURCE_VERSION_ID}"
echo "[prepare-source-bundle] uploaded s3://${CDK_PARAM_S3_BUCKET_NAME}/${CDK_SOURCE_NAME}"
cleanup_source_bundle_work_dir
trap - EXIT INT TERM
