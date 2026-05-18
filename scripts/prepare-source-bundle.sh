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

# repo root を決定 (= 本 script は repo の scripts/ 配下)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TENKACLOUD_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${TENKACLOUD_ROOT}"

# apps build (= source.zip 内 dist 同梱のため必須)
echo "[prepare-source-bundle] building apps/application-admin-console..."
(cd apps/application-admin-console && bun install --ignore-scripts && bun run build) >/dev/null
echo "[prepare-source-bundle] building apps/participant-portal..."
(cd apps/participant-portal && bun install --ignore-scripts && bun run build) >/dev/null

# staging
STAGING=$(mktemp -d)
trap "rm -rf '${STAGING}'" EXIT
echo "[prepare-source-bundle] staging at ${STAGING}..."

# SBT ref-arch 互換: infrastructure → cdk リネーム
cp -R infrastructure "${STAGING}/cdk"
cp -R scripts "${STAGING}/scripts"
cp -R problems "${STAGING}/problems"
cp -R packages "${STAGING}/packages"
cp .nvmrc "${STAGING}/.nvmrc"
cp package.json "${STAGING}/package.json"

# package.json の workspaces: "infrastructure" → "cdk" 置換 (= staging で名前が変わるため)
python3 -c "
import json
p = '${STAGING}/package.json'
with open(p) as f:
    pkg = json.load(f)
pkg['workspaces'] = [w if w != 'infrastructure' else 'cdk' for w in pkg.get('workspaces', [])]
with open(p, 'w') as f:
    json.dump(pkg, f, indent=2)
"

# clean up
find "${STAGING}" -type d \( -name node_modules -o -name cdk.out -o -name dist \) -prune -exec rm -rf {} +
find "${STAGING}" -type f \( -name ".env" -o -name ".env.local" \) -delete
find "${STAGING}" -name ".DS_Store" -delete

# dist は個別 copy (= 上記 find で消されているので)
mkdir -p "${STAGING}/apps/application-admin-console"
cp -R apps/application-admin-console/dist "${STAGING}/apps/application-admin-console/"
mkdir -p "${STAGING}/apps/participant-portal"
cp -R apps/participant-portal/dist "${STAGING}/apps/participant-portal/"

# zip + upload
cd "${STAGING}"
zip -rq "${CDK_SOURCE_NAME}" .
CDK_PARAM_COMMIT_ID=$(aws s3api put-object --bucket "${CDK_PARAM_S3_BUCKET_NAME}" \
  --key "${CDK_SOURCE_NAME}" --body "./${CDK_SOURCE_NAME}" --output text)
export CDK_PARAM_COMMIT_ID
echo "[prepare-source-bundle] uploaded s3://${CDK_PARAM_S3_BUCKET_NAME}/${CDK_SOURCE_NAME} (etag=${CDK_PARAM_COMMIT_ID})"
