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

# When started as root with a host uid (the Makefile passes TENKACLOUD_UID/GID), make the
# volume-backed node_modules and HOME writable by that uid, then drop privileges to it with
# gosu. This keeps writes to the bind-mounted repo (cdk.out, etc.) owned by the host user
# and runs the toolchain as non-root. A plain `docker compose run` (no uid) stays root.
if [ "$(id -u)" = "0" ] && [ -n "${TENKACLOUD_UID:-}" ]; then
  target="${TENKACLOUD_UID}:${TENKACLOUD_GID:-$TENKACLOUD_UID}"
  chown "${target}" "${HOME:-/home/tenkacloud}" 2>/dev/null || true
  chown -R "${target}" /workspace/node_modules /workspace/infrastructure/node_modules 2>/dev/null || true
  exec gosu "${target}" "$0" "$@"
fi

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
