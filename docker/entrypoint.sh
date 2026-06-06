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

exec "$@"
