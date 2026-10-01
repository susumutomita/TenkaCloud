#!/usr/bin/env bash
# Preserved per-account/region/environment bucket naming from the former cloud launcher.

tc_source_bucket_legacy_name() {
  printf 'tenkacloud-source-%s-%s' "$1" "$2"
}

# The per-environment 8-hex hash suffix. Mirrors prepare-source-bundle.sh exactly:
# the first 8 hex chars of sha256("<account>-<env>"). Args: <account> [env].
# `shasum -a 256` on macOS/most images, `sha256sum` fallback on minimal Linux.
tc_source_bucket_env_hash() {
  printf '%s' "$1-${2:-development}" | { shasum -a 256 2>/dev/null || sha256sum; } | cut -c1-8
}

# Canonical per-environment source bucket name (what deploy creates and cdk reads).
# Args: <account> <region> [env].
tc_source_bucket_name() {
  printf '%s-%s' \
    "$(tc_source_bucket_legacy_name "$1" "$2")" \
    "$(tc_source_bucket_env_hash "$1" "${3:-development}")"
}
