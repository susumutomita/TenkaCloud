#!/usr/bin/env bash
# Cloud hosting source preparation, adapted from the former single-installation launcher.
# The resolve-only seam is read-only; ordinary execution builds and uploads the source bundle.
set -euo pipefail

# Region resolution order: explicit REGION override → the standard AWS SDK env vars
# (CodeBuild / Lambda / ECS all inject AWS_REGION + AWS_DEFAULT_REGION) → the local
# `aws configure` profile. `aws configure get region` exits non-zero when there is no
# config file (= the case in CodeBuild), so it must be guarded with `|| true`; left
# bare it aborts this `set -e` script before the explicit error check below — which is
# exactly how Lite mode `make deploy` failed in the CodeBuild pipeline.
REGION="${REGION:-${AWS_REGION:-${AWS_DEFAULT_REGION:-}}}"
if [ -z "${REGION}" ]; then
  REGION="$(aws configure get region || true)"
fi
ACCOUNT_ID="${ACCOUNT_ID:-$(aws sts get-caller-identity --query Account --output text || true)}"

if [ -z "${REGION}" ] || [ -z "${ACCOUNT_ID}" ]; then
  echo "ERROR: REGION / ACCOUNT_ID を解決できません。 AWS_REGION / AWS_DEFAULT_REGION を export するか、 aws CLI を configure してください。"
  exit 1
fi

# Resolve a globally-unique, per-environment source bucket. A name of only
# account+region collides when a SECOND environment is deployed into the same
# account+region (S3 bucket names are global), so append a short hash of
# account+env. A hash (rather than the raw env name) keeps the bucket within the
# 63-char S3 limit for any environment name. The IAM grant in
# bootstrap-template/job-runner-permissions.ts matches the
# `tenkacloud-source-<account>-<region>*` prefix so every per-env bucket stays readable.
#
# We (re)compute when the name is unset, the Makefile's synth-only placeholder, OR
# the legacy non-hashed `tenkacloud-source-<account>-<region>` value (which the
# Makefile default still emits) — i.e. this script is authoritative and upgrades the
# legacy form to the per-env form. Other bucket names are rejected before any mutation.
# Bucket-name construction is centralized in scripts/names.sh (#2194) so the
# creator (here), cleanup, and the destroy path all compute the exact same strings.
# shellcheck source=lib/names.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/names.sh"
LEGACY_BUCKET="$(tc_source_bucket_legacy_name "${ACCOUNT_ID}" "${REGION}")"
if [ -z "${CDK_PARAM_S3_BUCKET_NAME:-}" ] \
  || [ "${CDK_PARAM_S3_BUCKET_NAME}" = "tenkacloud-source-placeholder" ] \
  || [ "${CDK_PARAM_S3_BUCKET_NAME}" = "${LEGACY_BUCKET}" ]; then
  CDK_PARAM_S3_BUCKET_NAME="$(tc_source_bucket_name "${ACCOUNT_ID}" "${REGION}" "${ENV:-development}")"
fi
CANONICAL_BUCKET="$(tc_source_bucket_name "${ACCOUNT_ID}" "${REGION}" "${ENV:-development}")"
if [ "${CDK_PARAM_S3_BUCKET_NAME}" != "${CANONICAL_BUCKET}" ]; then
  echo "Refusing an unrelated source bucket; expected ${CANONICAL_BUCKET}" >&2; exit 1
fi
export CDK_PARAM_S3_BUCKET_NAME
export CDK_SOURCE_NAME="${CDK_SOURCE_NAME:-source.zip}"

# Resolve-only seam: stop after env resolution so the resolution contract can be
# unit-tested without any AWS mutation (= infrastructure/test/scripts/prepare-source-bundle.test.ts).
if [ -n "${PREPARE_SOURCE_BUNDLE_RESOLVE_ONLY:-}" ]; then
  printf 'REGION=%s\nACCOUNT_ID=%s\nCDK_PARAM_S3_BUCKET_NAME=%s\nCDK_SOURCE_NAME=%s\n' \
    "${REGION}" "${ACCOUNT_ID}" "${CDK_PARAM_S3_BUCKET_NAME}" "${CDK_SOURCE_NAME}"
  exit 0
fi

# repo root を決定 (= 本 script は repo の scripts/ 配下)。 bucket lifecycle JSON を参照するため、
# bucket 作成 block より前に解決しておく。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TENKACLOUD_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

SOURCE_BUNDLE_WORK_DIR="${SOURCE_BUNDLE_WORK_DIR:-${TENKACLOUD_ROOT}/.cache/source-bundle}"
SOURCE_BUNDLE_ARCHIVE_PATH="${SOURCE_BUNDLE_ARCHIVE_PATH:-${SOURCE_BUNDLE_WORK_DIR}/${CDK_SOURCE_NAME}}"
source "${SCRIPT_DIR}/bundle-work-dir.sh"
tc_initialize_bundle_directory "${TENKACLOUD_ROOT}" "${SOURCE_BUNDLE_WORK_DIR}"
trap tc_clean_bundle_directory EXIT INT TERM

# `problems/` は TenkaCloudChallenge repo の git submodule。 ローカル clone 直後や
# 浅い CI checkout だと中身が空のまま source.zip に同梱されてしまうので、 ここで明示的に
# initialize / update する。 既存環境では no-op (= 早期 return)。
echo "[prepare-source-bundle] ensuring problems/ submodule is initialized..."
(cd "${TENKACLOUD_ROOT}" && git submodule update --init --recursive problems)

echo "[prepare-source-bundle] bucket=${CDK_PARAM_S3_BUCKET_NAME} key=${CDK_SOURCE_NAME}"

source "${SCRIPT_DIR}/source-bucket.sh"
tc_ensure_source_bucket "${CDK_PARAM_S3_BUCKET_NAME}" "${ACCOUNT_ID}" "${REGION}" "${ENV:-development}" "${SCRIPT_DIR}"
# These mutations happen only after ownership and purpose have been verified.
aws s3api put-bucket-versioning --bucket "${CDK_PARAM_S3_BUCKET_NAME}" --expected-bucket-owner "${ACCOUNT_ID}" --versioning-configuration Status=Enabled
aws s3api put-bucket-lifecycle-configuration --bucket "${CDK_PARAM_S3_BUCKET_NAME}" --expected-bucket-owner "${ACCOUNT_ID}" --lifecycle-configuration "file://${SCRIPT_DIR}/source-bundle-lifecycle.json"

cd "${TENKACLOUD_ROOT}"

# apps build (= source.zip 内 dist 同梱のため必須)
for app in application-admin-console participant-portal; do
  echo "[prepare-source-bundle] building apps/${app}..."
  (cd "apps/${app}" && bun run build) >/dev/null
done

echo "[prepare-source-bundle] packaging local archive..."
SOURCE_BUNDLE_ROOT="${TENKACLOUD_ROOT}" \
  SOURCE_BUNDLE_WORK_DIR="${SOURCE_BUNDLE_WORK_DIR}" \
  SOURCE_BUNDLE_ARCHIVE_PATH="${SOURCE_BUNDLE_ARCHIVE_PATH}" \
  bash "${SCRIPT_DIR}/package-source-bundle.sh"

echo "[prepare-source-bundle] uploading ${SOURCE_BUNDLE_ARCHIVE_PATH}..."
CDK_PARAM_COMMIT_ID=$(aws s3api put-object --bucket "${CDK_PARAM_S3_BUCKET_NAME}" \
  --expected-bucket-owner "${ACCOUNT_ID}" --key "${CDK_SOURCE_NAME}" --body "${SOURCE_BUNDLE_ARCHIVE_PATH}" --output text)
export CDK_PARAM_COMMIT_ID
echo "[prepare-source-bundle] uploaded s3://${CDK_PARAM_S3_BUCKET_NAME}/${CDK_SOURCE_NAME} (etag=${CDK_PARAM_COMMIT_ID})"
