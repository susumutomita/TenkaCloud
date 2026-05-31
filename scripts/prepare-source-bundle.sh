#!/usr/bin/env bash
# Issue: Lite mode `make deploy` の DeployCodeBuild が `source.zip` を要求するため、
# bucket / source.zip を事前に作成する。 install.sh / tenkacloud-lite.ts cmdUp の両方が
# **同じ** 手順で source.zip を staging する必要があるため、 ここを single source of truth に
# する (= 旧来 install.sh inline 80 行と本 script の duplication を避ける)。
#
# 呼び出し方は 2 つ:
#
#   1. `source scripts/prepare-source-bundle.sh` (= install.sh が使う)
#      → caller shell に CDK_PARAM_S3_BUCKET_NAME / CDK_SOURCE_NAME / CDK_PARAM_COMMIT_ID を
#        export する。 install.sh は後段の cdk deploy でこれらを参照する。
#
#   2. `bash scripts/prepare-source-bundle.sh` (= tenkacloud-lite.ts cmdUp が使う)
#      → 独立 subshell で実行。 終了時に caller に env を返さない代わりに、 cdk deploy 側で
#        Makefile の CDK_PARAM_S3_BUCKET_NAME 既定値が同じ pattern (tenkacloud-source-...) で
#        計算されるので一致する (= deterministic な bucket 名)。
#
# 副作用 (= idempotent):
#   - `tenkacloud-source-<account>-<region>` bucket を作成 (= 存在しない場合)
#   - `apps/application-admin-console/dist` と `apps/participant-portal/dist` を build
#   - `<bucket>/source.zip` を upload
set -euo pipefail

REGION=${REGION:-$(aws configure get region)}
ACCOUNT_ID=${ACCOUNT_ID:-$(aws sts get-caller-identity --query Account --output text)}

if [ -z "${REGION}" ] || [ -z "${ACCOUNT_ID}" ]; then
  echo "ERROR: REGION / ACCOUNT_ID を解決できません。 AWS CLI が configure 済か、 env 変数を export してください。"
  exit 1
fi

export CDK_PARAM_S3_BUCKET_NAME="${CDK_PARAM_S3_BUCKET_NAME:-tenkacloud-source-${ACCOUNT_ID}-${REGION}}"
export CDK_SOURCE_NAME="${CDK_SOURCE_NAME:-source.zip}"

# repo root を決定 (= 本 script は repo の scripts/ 配下)。 bucket lifecycle JSON を参照するため、
# bucket 作成 block より前に解決しておく。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TENKACLOUD_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# `problems/` は TenkaCloudChallenge repo の git submodule。 ローカル clone 直後や
# 浅い CI checkout だと中身が空のまま source.zip に同梱されてしまうので、 ここで明示的に
# initialize / update する。 既存環境では no-op (= 早期 return)。
echo "[prepare-source-bundle] ensuring problems/ submodule is initialized..."
(cd "${TENKACLOUD_ROOT}" && git submodule update --init --recursive --force problems)

echo "[prepare-source-bundle] bucket=${CDK_PARAM_S3_BUCKET_NAME} key=${CDK_SOURCE_NAME}"

# bucket を作成 (= 既存なら skip、 idempotent)
if aws s3api head-bucket --bucket "${CDK_PARAM_S3_BUCKET_NAME}" --expected-bucket-owner "${ACCOUNT_ID}" 2>/dev/null; then
  echo "[prepare-source-bundle] bucket ${CDK_PARAM_S3_BUCKET_NAME} already exists (owned by ${ACCOUNT_ID})"
else
  echo "[prepare-source-bundle] creating bucket ${CDK_PARAM_S3_BUCKET_NAME}..."
  if [ "${REGION}" = "us-east-1" ]; then
    aws s3api create-bucket --bucket "${CDK_PARAM_S3_BUCKET_NAME}"
  else
    aws s3api create-bucket --bucket "${CDK_PARAM_S3_BUCKET_NAME}" --region "${REGION}" \
      --create-bucket-configuration LocationConstraint="${REGION}"
  fi
  aws s3api put-bucket-versioning --bucket "${CDK_PARAM_S3_BUCKET_NAME}" \
    --versioning-configuration Status=Enabled
  aws s3api put-public-access-block --bucket "${CDK_PARAM_S3_BUCKET_NAME}" \
    --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
fi

# Issue #1056: lifecycle policy を idempotent に PUT する (= 過去 bucket で未設定でも是正)。
# 設定値は `infrastructure/environments/<env>/config.json` の `sourceBundleConfig` を
# source of truth とし、 emit script が AWS API shape の JSON を stdout に出力する
# (= config の二重持ちを避け、 `${VAR:-default}` placeholder で env override 可)。
echo "[prepare-source-bundle] applying lifecycle policy..."
LIFECYCLE_JSON=$(bun run "${SCRIPT_DIR}/print-source-bundle-lifecycle.ts" "${ENV:-development}")
aws s3api put-bucket-lifecycle-configuration \
  --bucket "${CDK_PARAM_S3_BUCKET_NAME}" \
  --lifecycle-configuration "${LIFECYCLE_JSON}"

cd "${TENKACLOUD_ROOT}"

# apps build (= source.zip 内 dist 同梱のため必須)
echo "[prepare-source-bundle] building apps/application-admin-console..."
(cd apps/application-admin-console && bun install --ignore-scripts && bun run build) >/dev/null
echo "[prepare-source-bundle] building apps/participant-portal..."
(cd apps/participant-portal && bun install --ignore-scripts && bun run build) >/dev/null

# Keep local packaging separate from AWS orchestration so fixture tests can
# validate the archive contract without credentials. The work directory is
# fixed and cleaned on every exit to avoid orphaned multi-gigabyte archives.
SOURCE_BUNDLE_WORK_DIR="${SOURCE_BUNDLE_WORK_DIR:-${TENKACLOUD_ROOT}/.cache/source-bundle}"
SOURCE_BUNDLE_ARCHIVE_PATH="${SOURCE_BUNDLE_ARCHIVE_PATH:-${SOURCE_BUNDLE_WORK_DIR}/${CDK_SOURCE_NAME}}"
case "${SOURCE_BUNDLE_WORK_DIR}" in
  "" | "/" | "${TENKACLOUD_ROOT}")
    echo "[prepare-source-bundle] ERROR: unsafe SOURCE_BUNDLE_WORK_DIR=${SOURCE_BUNDLE_WORK_DIR}" >&2
    exit 1
    ;;
esac
case "${SOURCE_BUNDLE_WORK_DIR}" in
  /*) ;;
  *)
    echo "[prepare-source-bundle] ERROR: SOURCE_BUNDLE_WORK_DIR must be absolute" >&2
    exit 1
    ;;
esac
if [ -L "${SOURCE_BUNDLE_WORK_DIR}" ]; then
  echo "[prepare-source-bundle] ERROR: SOURCE_BUNDLE_WORK_DIR must not be a symlink" >&2
  exit 1
fi
cleanup_source_bundle_work_dir() {
  if [ -d "${SOURCE_BUNDLE_WORK_DIR}" ]; then
    find "${SOURCE_BUNDLE_WORK_DIR}" -depth -mindepth 1 -delete
  fi
}
trap cleanup_source_bundle_work_dir EXIT INT TERM

echo "[prepare-source-bundle] packaging local archive..."
SOURCE_BUNDLE_ROOT="${TENKACLOUD_ROOT}" \
  SOURCE_BUNDLE_WORK_DIR="${SOURCE_BUNDLE_WORK_DIR}" \
  SOURCE_BUNDLE_ARCHIVE_PATH="${SOURCE_BUNDLE_ARCHIVE_PATH}" \
  bash "${SCRIPT_DIR}/package-source-bundle.sh"

echo "[prepare-source-bundle] uploading ${SOURCE_BUNDLE_ARCHIVE_PATH}..."
CDK_PARAM_COMMIT_ID=$(aws s3api put-object --bucket "${CDK_PARAM_S3_BUCKET_NAME}" \
  --key "${CDK_SOURCE_NAME}" --body "${SOURCE_BUNDLE_ARCHIVE_PATH}" --output text)
export CDK_PARAM_COMMIT_ID
echo "[prepare-source-bundle] uploaded s3://${CDK_PARAM_S3_BUCKET_NAME}/${CDK_SOURCE_NAME} (etag=${CDK_PARAM_COMMIT_ID})"
