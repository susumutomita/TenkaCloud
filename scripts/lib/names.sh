#!/usr/bin/env bash
# Single source of truth for the SaaS source-bundle S3 bucket name (#2194).
#
# The source-bundle bucket is NOT created by CDK — `scripts/prepare-source-bundle.sh`
# creates it and uploads `source.zip`, and `serverless-saas-pipeline.ts` imports it by
# name via `fromBucketName`. Its name had drifted into two forms across the scripts:
#
#   - canonical (hashed): tenkacloud-source-<account>-<region>-<8hex>  ← what deploy creates
#   - legacy (no hash):   tenkacloud-source-<account>-<region>         ← pre-#1749
#
# `install.sh` sources `prepare-source-bundle.sh`, which upgrades to and creates the
# HASHED name, then `cdk deploy` reads that same name — so the hashed form is the real
# deployed bucket. The no-hash form is legacy and only lingers for cleanup. Centralize
# both here so every script computes identical strings.
#
# The 8-hex suffix is a per-environment hash of "<account>-<env>" so a second
# environment in the same account+region does not collide (S3 bucket names are global).

# Legacy account+region name (pre-#1749). Args: <account> <region>.
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
