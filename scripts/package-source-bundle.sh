#!/usr/bin/env bash
# Build the local source.zip consumed by CodeBuild without touching AWS.
# prepare-source-bundle.sh owns remote bucket setup and upload; this script owns
# the deterministic local packaging contract so it can be tested with fixtures.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_BUNDLE_ROOT="${SOURCE_BUNDLE_ROOT:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
SOURCE_BUNDLE_WORK_DIR="${SOURCE_BUNDLE_WORK_DIR:-${SOURCE_BUNDLE_ROOT}/.cache/source-bundle}"
SOURCE_BUNDLE_STAGING_DIR="${SOURCE_BUNDLE_WORK_DIR}/staging"
SOURCE_BUNDLE_ARCHIVE_PATH="${SOURCE_BUNDLE_ARCHIVE_PATH:-${SOURCE_BUNDLE_WORK_DIR}/source.zip}"
SOURCE_BUNDLE_MAX_STAGING_MB="${SOURCE_BUNDLE_MAX_STAGING_MB:-256}"
SOURCE_BUNDLE_MAX_ARCHIVE_MB="${SOURCE_BUNDLE_MAX_ARCHIVE_MB:-128}"

case "${SOURCE_BUNDLE_WORK_DIR}" in
  "" | "/" | "${SOURCE_BUNDLE_ROOT}")
    echo "[package-source-bundle] ERROR: unsafe SOURCE_BUNDLE_WORK_DIR=${SOURCE_BUNDLE_WORK_DIR}" >&2
    exit 1
    ;;
esac

case "${SOURCE_BUNDLE_WORK_DIR}" in
  /*) ;;
  *)
    echo "[package-source-bundle] ERROR: SOURCE_BUNDLE_WORK_DIR must be absolute" >&2
    exit 1
    ;;
esac

if [ -L "${SOURCE_BUNDLE_WORK_DIR}" ]; then
  echo "[package-source-bundle] ERROR: SOURCE_BUNDLE_WORK_DIR must not be a symlink" >&2
  exit 1
fi

case "${SOURCE_BUNDLE_ARCHIVE_PATH}" in
  "${SOURCE_BUNDLE_WORK_DIR}/"*) ;;
  *)
    echo "[package-source-bundle] ERROR: archive path must stay inside work directory" >&2
    exit 1
    ;;
esac

case "${SOURCE_BUNDLE_ARCHIVE_PATH}" in
  "${SOURCE_BUNDLE_STAGING_DIR}" | "${SOURCE_BUNDLE_STAGING_DIR}/"*)
    echo "[package-source-bundle] ERROR: archive path must be outside staging directory" >&2
    exit 1
    ;;
esac

for value in SOURCE_BUNDLE_MAX_STAGING_MB SOURCE_BUNDLE_MAX_ARCHIVE_MB; do
  if ! [[ "${!value}" =~ ^[1-9][0-9]*$ ]]; then
    echo "[package-source-bundle] ERROR: ${value} must be a positive integer" >&2
    exit 1
  fi
done

clean_work_dir() {
  if [ -d "${SOURCE_BUNDLE_WORK_DIR}" ]; then
    find "${SOURCE_BUNDLE_WORK_DIR}" -depth -mindepth 1 -delete
  fi
}

RSYNC_EXCLUDES=(
  --exclude=node_modules
  --exclude='cdk.out*'
  --exclude=dist
  --exclude=coverage
  --exclude=.cache
  --exclude=.git
  --exclude='.env*'
  --exclude=.DS_Store
)

copy_tree() {
  local source_dir="$1"
  local target_dir="$2"
  if [ ! -d "${SOURCE_BUNDLE_ROOT}/${source_dir}" ]; then
    echo "[package-source-bundle] ERROR: required directory missing: ${source_dir}" >&2
    exit 1
  fi
  echo "[package-source-bundle] copying ${source_dir}/ -> ${target_dir}/"
  mkdir -p "${SOURCE_BUNDLE_STAGING_DIR}/${target_dir}"
  rsync -a "${RSYNC_EXCLUDES[@]}" \
    "${SOURCE_BUNDLE_ROOT}/${source_dir}/" "${SOURCE_BUNDLE_STAGING_DIR}/${target_dir}/"
}

# The problem catalog ships from the `problems` git submodule. An uninitialised
# submodule leaves problems/ as an empty mount point, so copy_tree's existence
# check passes but the bundle would carry zero problems. Every per-team deploy
# would then abort at deploy-battles.sh's "template not found" guard BEFORE any
# CloudFormation request is made (the failure an operator sees as a deploy that
# "never reaches CloudFormation"). Fail loudly here instead of shipping an empty
# catalog. metadata.json presence is the signal: every problem dir ships one.
require_problem_catalog() {
  local catalog_dir="${SOURCE_BUNDLE_ROOT}/problems"
  local found
  found="$(set +o pipefail; find "${catalog_dir}" -name metadata.json -type f 2>/dev/null | head -n 1)"
  if [ -z "${found}" ]; then
    echo "[package-source-bundle] ERROR: ${catalog_dir} contains no metadata.json — the problem catalog submodule is not checked out. Run 'git submodule update --init --recursive' before packaging." >&2
    exit 1
  fi
}

# [Problem Packs / #2459 gap 2] `.tenkacloud/pack-store` holds installed pack
# snapshots plus the `packs-lock.json` lock file + `pack-activations.json`
# (#2090 / #2462) — repo-root local state, gitignored (`.tenkacloud/` in
# .gitignore), created by `pack-cli install` / `activate`. It is OPTIONAL: a
# checkout with no packs installed has no `.tenkacloud/` directory at all, so
# unlike copy_tree's REQUIRED-directory contract this must not fail when the
# store is absent. When it IS present, copy failures still fail loudly like
# every other copy_tree call (set -euo pipefail makes rsync's exit fatal) —
# there is no silent fallback the other way. Only `pack-store` is copied, not
# all of `.tenkacloud/` — `.tenkacloud/local/` is unrelated Docker local-play
# state (`make local`, scripts/tenkacloud-local.ts) that has no business in a
# CodeBuild source bundle.
copy_pack_store_if_present() {
  local pack_store_dir="${SOURCE_BUNDLE_ROOT}/.tenkacloud/pack-store"
  if [ ! -d "${pack_store_dir}" ]; then
    echo "[package-source-bundle] no .tenkacloud/pack-store found, skipping (packs are optional)"
    return 0
  fi
  copy_tree ".tenkacloud/pack-store" ".tenkacloud/pack-store"
}

copy_dist() {
  local app="$1"
  local dist="${SOURCE_BUNDLE_ROOT}/apps/${app}/dist"
  if [ ! -d "${dist}" ]; then
    echo "[package-source-bundle] ERROR: required app build missing: apps/${app}/dist" >&2
    exit 1
  fi
  echo "[package-source-bundle] adding apps/${app}/dist"
  mkdir -p "${SOURCE_BUNDLE_STAGING_DIR}/apps/${app}"
  cp -R "${dist}" "${SOURCE_BUNDLE_STAGING_DIR}/apps/${app}/"
}

echo "[package-source-bundle] resetting work directory ${SOURCE_BUNDLE_WORK_DIR}"
clean_work_dir
mkdir -p "${SOURCE_BUNDLE_STAGING_DIR}"

# Root allowlist: unknown repo-local directories are excluded by construction.
copy_tree "infrastructure" "cdk"
copy_tree "scripts" "scripts"
copy_tree "problems" "problems"
require_problem_catalog
copy_tree "packages" "packages"
copy_pack_store_if_present
cp "${SOURCE_BUNDLE_ROOT}/.nvmrc" "${SOURCE_BUNDLE_STAGING_DIR}/.nvmrc"
cp "${SOURCE_BUNDLE_ROOT}/package.json" "${SOURCE_BUNDLE_STAGING_DIR}/package.json"

echo "[package-source-bundle] rewriting workspace path infrastructure -> cdk"
python3 - "${SOURCE_BUNDLE_STAGING_DIR}/package.json" <<'PY'
import json
import sys

path = sys.argv[1]
with open(path) as source:
    package = json.load(source)
package["workspaces"] = [
    workspace if workspace != "infrastructure" else "cdk"
    for workspace in package.get("workspaces", [])
]
with open(path, "w") as target:
    json.dump(package, target, indent=2)
PY

for app in admin-console application-admin-console participant-portal; do
  copy_dist "${app}"
done

staging_kib="$(du -sk "${SOURCE_BUNDLE_STAGING_DIR}" | awk '{print $1}')"
max_staging_kib="$((SOURCE_BUNDLE_MAX_STAGING_MB * 1024))"
echo "[package-source-bundle] staged size=${staging_kib} KiB limit=${max_staging_kib} KiB"
if [ "${staging_kib}" -gt "${max_staging_kib}" ]; then
  echo "[package-source-bundle] ERROR: staged bundle exceeds limit before archive creation" >&2
  exit 1
fi

echo "[package-source-bundle] creating archive ${SOURCE_BUNDLE_ARCHIVE_PATH}"
mkdir -p "$(dirname "${SOURCE_BUNDLE_ARCHIVE_PATH}")"
(cd "${SOURCE_BUNDLE_STAGING_DIR}" && zip -rq "${SOURCE_BUNDLE_ARCHIVE_PATH}" .)

archive_bytes="$(wc -c < "${SOURCE_BUNDLE_ARCHIVE_PATH}" | tr -d '[:space:]')"
max_archive_bytes="$((SOURCE_BUNDLE_MAX_ARCHIVE_MB * 1024 * 1024))"
echo "[package-source-bundle] archive size=${archive_bytes} bytes limit=${max_archive_bytes} bytes"
if [ "${archive_bytes}" -gt "${max_archive_bytes}" ]; then
  echo "[package-source-bundle] ERROR: archive exceeds upload limit" >&2
  exit 1
fi

echo "[package-source-bundle] archive ready at ${SOURCE_BUNDLE_ARCHIVE_PATH}"
