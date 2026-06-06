#!/usr/bin/env bash
#
# Entrypoint for the TenkaCloud deploy container (docker/Dockerfile).
#
# node_modules live on named volumes (see docker-compose.yml) so the host's
# possibly-foreign-platform binaries never leak into the Linux container. On first run
# those volumes are empty, so dependencies are installed before handing control to the
# requested command (default: `make deploy`).
#
# --frozen-lockfile: never mutate the bind-mounted bun.lock on the host, and fail loudly
#   if the lockfile is stale (no silent fallback).
# --ignore-scripts: same supply-chain posture as `make install` / `make install_ci`.
set -euo pipefail

echo "==> Installing dependencies into the container (Linux-native, volume-backed node_modules)"
bun install --frozen-lockfile --ignore-scripts

# A local `aws login` (the mounted ~/.aws default profile / SSO cache) is the intended
# credential source. docker-compose forwards AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY /
# AWS_SESSION_TOKEN, but an empty or partial pair (e.g. a host that exports an empty
# AWS_ACCESS_KEY_ID) would shadow that profile and make the AWS SDK / CLI fail instead of
# falling back. Drop them unless a complete static key pair is actually present.
if [ -z "${AWS_ACCESS_KEY_ID:-}" ] || [ -z "${AWS_SECRET_ACCESS_KEY:-}" ]; then
  unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
fi

exec "$@"
