# syntax=docker/dockerfile:1
#
# [#2906 / ADR-055] Docker-only participant local-play control plane.
#
# Runs the SAME `scripts/tenkacloud-local.ts` engine the host Bun dev path
# (`make local-dev`) uses, plus the prebuilt Participant Portal, from one
# image on one port — so a participant needs only Docker, never Bun/Node/
# node_modules. Build this from the REPO ROOT as the context
# (`docker build -f docker/local-control-plane/Dockerfile .`); see
# ../../compose.local.yaml for how `make local` invokes it.
#
# `problems/` is NEVER baked into this image — see ../../.dockerignore. It is
# bind-mounted read-only at the container's OWN absolute path match at run
# time (compose.local.yaml), because a per-problem compose file's relative
# bind mounts are resolved by the HOST Docker daemon against whatever
# absolute path this container's `docker compose` invocation sends it
# (docker-outside-of-docker) — see scripts/local-play/catalog-loader.ts's
# `problemSearchRoots` for the full rationale.

FROM oven/bun:1.3.11-alpine AS build
WORKDIR /app
COPY . .
# --ignore-scripts: bun does not honour npm_config_ignore_scripts or .npmrc's
# ignore-scripts, so this flag is required on every invocation (defuses the
# mini-shai-hulud-class supply-chain risk the same way `make install` does —
# see Makefile:40-46). --frozen-lockfile: a build must never silently
# resolve a different dependency tree than bun.lock records.
RUN bun install --frozen-lockfile --ignore-scripts
RUN bun run --filter @TenkaCloud/participant-portal build

FROM oven/bun:1.3.11-alpine AS runtime
WORKDIR /app

# Docker CLI + Compose plugin for the docker-outside-of-docker sibling-container
# pattern this control plane already uses on the host today (unchanged code —
# scripts/local-play/docker-adapter.ts shells out to `docker compose` exactly
# as it does outside a container). The Compose plugin is fetched as a pinned
# release binary, NOT via `apk add docker-cli-compose`, so its version is
# explicit and auditable rather than whatever happens to be in the base
# image's Alpine package index — CVE-2025-62725 (fixed 2.40.2, CVSS 8.9) is a
# path-traversal-to-host-write bug in exactly this kind of untrusted-compose-
# file-processing position (this container processes `problems/` catalog
# compose files it did not author), so this floor is a security requirement,
# not a convenience pin. Raise the version here, not with a Renovate-style
# floating tag.
ARG DOCKER_COMPOSE_VERSION=v2.40.2
RUN apk add --no-cache docker-cli \
  && arch="$(uname -m)" \
  && mkdir -p /usr/local/lib/docker/cli-plugins \
  && wget -qO /usr/local/lib/docker/cli-plugins/docker-compose \
       "https://github.com/docker/compose/releases/download/${DOCKER_COMPOSE_VERSION}/docker-compose-linux-${arch}" \
  && chmod +x /usr/local/lib/docker/cli-plugins/docker-compose \
  && docker compose version

COPY --from=build /app /app

ENV TENKACLOUD_LOCAL_BIND_HOST=0.0.0.0
ENV TENKACLOUD_LOCAL_DIR=/data
ENV TENKACLOUD_LOCAL_PORTAL_DIST=/app/apps/participant-portal/dist
ENV LOCAL_API_PORT=5175
VOLUME ["/data"]
EXPOSE 5175

# Runs in the FOREGROUND as this container's PID 1 (not `up`'s host-oriented
# detach-and-track-by-PID model — see containerServe() in
# scripts/tenkacloud-local.ts) so `docker stop` / `docker compose down`
# deliver SIGTERM directly to it, which is what stops every running
# per-problem container and persists state before exit.
ENTRYPOINT ["bun", "run", "scripts/tenkacloud-local.ts", "container-serve"]
