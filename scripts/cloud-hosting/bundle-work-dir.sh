#!/usr/bin/env bash
# Cleanup is allowed only in this repository's explicitly marked bundle directory.
tc_initialize_bundle_directory() {
  local root="$1" work="$2"
  case "${work}" in /*) ;; *) echo "Bundle work directory must be absolute" >&2; return 1 ;; esac
  if [ -L "${work}" ]; then echo "Bundle work directory must not be a symlink" >&2; return 1; fi
  SOURCE_BUNDLE_ROOT="$(python3 -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "${root}")"
  SOURCE_BUNDLE_WORK_DIR="$(python3 -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "${work}")"
  if [ "${SOURCE_BUNDLE_WORK_DIR}" != "${SOURCE_BUNDLE_ROOT}/.cache/source-bundle" ]; then
    echo "Bundle cleanup is restricted to the repository's .cache/source-bundle directory" >&2
    return 1
  fi
  TC_BUNDLE_MARKER="${SOURCE_BUNDLE_WORK_DIR}/.tenkacloud-bundle-owner"
  TC_BUNDLE_OWNER="tenkacloud-cloud-source-bundle-v1:${SOURCE_BUNDLE_ROOT}"
  if [ -L "${TC_BUNDLE_MARKER}" ]; then echo "Bundle ownership marker must not be a symlink" >&2; return 1; fi
  if [ -e "${TC_BUNDLE_MARKER}" ]; then
    if [ ! -f "${TC_BUNDLE_MARKER}" ] || [ "$(cat "${TC_BUNDLE_MARKER}")" != "${TC_BUNDLE_OWNER}" ]; then
      echo "Bundle ownership marker mismatch; refusing cleanup" >&2; return 1
    fi
  elif [ -d "${SOURCE_BUNDLE_WORK_DIR}" ] && [ -n "$(find "${SOURCE_BUNDLE_WORK_DIR}" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
    echo "Existing bundle directory is unowned and nonempty; refusing adoption" >&2; return 1
  else
    mkdir -p "${SOURCE_BUNDLE_WORK_DIR}"
    printf '%s\n' "${TC_BUNDLE_OWNER}" > "${TC_BUNDLE_MARKER}"
  fi
}

tc_clean_bundle_directory() {
  if [ -L "${SOURCE_BUNDLE_WORK_DIR}" ] || [ -L "${TC_BUNDLE_MARKER}" ] || [ ! -f "${TC_BUNDLE_MARKER}" ] || [ "$(cat "${TC_BUNDLE_MARKER}")" != "${TC_BUNDLE_OWNER}" ]; then
    echo "Bundle ownership changed; refusing cleanup" >&2; return 1
  fi
  find "${SOURCE_BUNDLE_WORK_DIR}" -depth -mindepth 1 ! -path "${TC_BUNDLE_MARKER}" -delete
}
