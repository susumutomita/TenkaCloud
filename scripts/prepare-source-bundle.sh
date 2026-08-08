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
#   - CDK app が参照する3 SPAの `dist` を build
#   - `<bucket>/source.zip` を upload
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
# legacy form to the per-env form. An explicit custom bucket name is left untouched.
# Bucket-name construction is centralized in scripts/lib/names.sh (#2194) so the
# creator (here), cleanup, and the destroy path all compute the exact same strings.
# shellcheck source=lib/names.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/names.sh"
LEGACY_BUCKET="$(tc_source_bucket_legacy_name "${ACCOUNT_ID}" "${REGION}")"
if [ -z "${CDK_PARAM_S3_BUCKET_NAME:-}" ] \
  || [ "${CDK_PARAM_S3_BUCKET_NAME}" = "tenkacloud-source-placeholder" ] \
  || [ "${CDK_PARAM_S3_BUCKET_NAME}" = "${LEGACY_BUCKET}" ]; then
  CDK_PARAM_S3_BUCKET_NAME="$(tc_source_bucket_name "${ACCOUNT_ID}" "${REGION}" "${ENV:-development}")"
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
  aws s3api put-public-access-block --bucket "${CDK_PARAM_S3_BUCKET_NAME}" \
    --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
fi

# versioning は create-only ではなく **毎回** 適用する idempotent toggle (= 既存 bucket も flip する)。
#
# 既定は Enabled。 この bucket は serverless-saas-pipeline.ts の `S3SourceAction` の source なので、
# CodePipeline が versioning を必須にする。 Suspended だと pipeline の Source stage が
#   The source artifact bucket '<bucket>' is not versioned.
# で即失敗し、 tenant 更新用の pipeline が構造的に一度も通らない (2026-08-08 に実測)。
# install.sh は同じ実行の中でこの bucket を用意し pipeline も立てるので、 Suspended 既定は
# 自己矛盾だった。
#
# 旧既定 Suspended の理由 (同 key へ source.zip を PUT し続けて旧 version が無限蓄積する) は、
# すぐ下で適用する lifecycle policy が既に解決している (NoncurrentDays=1 / NewerNoncurrentVersions=5)。
# 明示的に false / suspended / 0 を渡したときだけ Suspended に倒せるが、 pipeline を使う構成では
# 選んではいけない。
case "$(printf '%s' "${CDK_PARAM_SOURCE_BUCKET_VERSIONING:-}" | tr '[:upper:]' '[:lower:]')" in
  false | suspended | 0) VERSIONING_STATUS="Suspended" ;;
  *) VERSIONING_STATUS="Enabled" ;;
esac
echo "[prepare-source-bundle] setting bucket versioning: ${VERSIONING_STATUS}"
aws s3api put-bucket-versioning --bucket "${CDK_PARAM_S3_BUCKET_NAME}" \
  --versioning-configuration "Status=${VERSIONING_STATUS}"

# Issue #1056: lifecycle policy を idempotent に PUT する (= 過去 bucket で未設定でも是正)。
# 設定値は `infrastructure/environments/<env>/config.json` の `sourceBundleConfig` を
# source of truth とし、 emit script が AWS API shape の JSON を stdout に出力する
# (= config の二重持ちを避け、 `${VAR:-default}` placeholder で env override 可)。
echo "[prepare-source-bundle] applying lifecycle policy..."
LIFECYCLE_JSON=$(bun run "${SCRIPT_DIR}/ops/print-source-bundle-lifecycle.ts" "${ENV:-development}")
aws s3api put-bucket-lifecycle-configuration \
  --bucket "${CDK_PARAM_S3_BUCKET_NAME}" \
  --lifecycle-configuration "${LIFECYCLE_JSON}"

cd "${TENKACLOUD_ROOT}"

# apps build (= source.zip 内 dist 同梱のため必須)
for app in admin-console application-admin-console participant-portal; do
  echo "[prepare-source-bundle] building apps/${app}..."
  (cd "apps/${app}" && bun install --ignore-scripts && bun run build) >/dev/null
done

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
