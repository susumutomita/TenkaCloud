#!/usr/bin/env bash
# Deterministic source-bundle bucket names shared by cloud deployment utilities.
# An eight-character account/environment hash distinguishes environments in the
# same account and region while keeping names within S3's 63-character limit.
tc_source_bucket_legacy_name() {
  printf 'tenkacloud-source-%s-%s' "$1" "$2"
}

tc_source_bucket_env_hash() {
  printf '%s' "$1-${2:-development}" | { shasum -a 256 2>/dev/null || sha256sum; } | cut -c1-8
}

tc_source_bucket_name() {
  printf '%s-%s' \
    "$(tc_source_bucket_legacy_name "$1" "$2")" \
    "$(tc_source_bucket_env_hash "$1" "${3:-development}")"
}
