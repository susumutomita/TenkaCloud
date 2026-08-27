# syntax=docker/dockerfile:1
#
# [#2906] Docker-only participant local-play control plane.
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
# Manifests BEFORE sources, so the install layer is keyed on the dependency tree
# rather than on the whole repository. `COPY . .` used to sit here, which meant
# editing any one file — a comment in a test, anything — invalidated the install
# below and cost a full re-resolve (measured: 145s) on every `make local`. Every
# workspace root in package.json ("infrastructure", "apps/*", "packages/*") needs
# its manifest present for the resolve; `--frozen-lockfile` is what makes a
# missing one fail loudly instead of silently resolving a different tree, so a
# newly added app cannot slip past this list unnoticed. apps/always-on-control-plane
# is absent on purpose: it carries no package.json, so it is not a workspace member.
COPY package.json bun.lock ./
COPY packages ./packages
COPY infrastructure/package.json ./infrastructure/
COPY apps/admin-console/package.json ./apps/admin-console/
COPY apps/application-admin-console/package.json ./apps/application-admin-console/
COPY apps/developer-portal/package.json ./apps/developer-portal/
COPY apps/participant-portal/package.json ./apps/participant-portal/
# --ignore-scripts: bun does not honour npm_config_ignore_scripts or .npmrc's
# ignore-scripts, so this flag is required on every invocation (defuses the
# mini-shai-hulud-class supply-chain risk the same way `make install` does —
# see Makefile:40-46). --frozen-lockfile: a build must never silently
# resolve a different dependency tree than bun.lock records.
#
# The cache mount keeps bun's package cache across builds, so the runs that DO
# miss the layer cache (a lockfile change) re-link from disk instead of
# re-downloading the registry. It is a cache, not a source of versions —
# bun.lock still decides what gets installed.
RUN --mount=type=cache,target=/root/.bun/install/cache \
      bun install --frozen-lockfile --ignore-scripts
COPY . .
RUN bun run --filter @TenkaCloud/participant-portal build

# 実行時の依存だけを別に解決する。 build stage の node_modules を持ち込むと、 この control
# plane が一度も読まないものが image に載る — 実測で 1.8GB のうち 1GB 以上が別アプリと
# ビルド道具だった (next 410MB = developer-portal、 aws-cdk-lib 144MB = infrastructure、
# @biomejs 109MB = linter)。 portal の
# frontend 依存 (cloudscape / ace-builds 等) も dist に bundle 済みで、 実行時には要らない。
#
# workspace を `packages/*` だけに絞って install し直す。 root の dependencies は 3 つしか
# 無く (`@libsql/client` / `@tenkacloud/coordination-plugin-sdk` / `ws`)、 control plane が
# import する `@tenkacloud/*` は packages/ にある。 `infrastructure` と `apps/*` を
# workspace から外すことが、 上の 1GB を落とす操作そのものになる。
#
# devDependencies も落とす。 `--production` は使えない — bun 1.3 では frozen lockfile を
# 含意し、 workspace 集合を変えた時点で必ず失敗する (`CI=false` でも `--no-frozen-lockfile`
# でも外せない)。 package.json から消すほうが、 同じ結果を素の install で得られる。
#
# 版の出所は build stage と同じ bun.lock なので、 解決結果が食い違うことはない。 供給鎖の
# 担保は `--ignore-scripts` 側が持つ (build stage と同じ理由)。
FROM oven/bun:1.3.11-alpine AS runtime-deps
WORKDIR /app
COPY bun.lock ./
COPY package.json ./package.json.full
COPY packages ./packages
# `workspaces` を packages/* だけに書き換える。 他の field はそのまま残す。
RUN bun --eval ' \
      const pkg = JSON.parse(await Bun.file("package.json.full").text()); \
      pkg.workspaces = ["packages/*"]; \
      delete pkg.devDependencies; \
      await Bun.write("package.json", JSON.stringify(pkg, null, 2)); \
    ' \
  && rm package.json.full
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --ignore-scripts

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

# build stage の /app を丸ごと持ち込まない。 実行時に読むものだけを名指しで入れる。
# 以前は `COPY --from=build /app /app` で、 image 3.71GB のうち 2.6GB がこの 1 レイヤー
# だった — tmp/ 390MB、 sampleimages/ 33MB、 docs/、 landing/、 infrastructure/、 そして
# 他アプリの node_modules まで、 この control plane が一度も開かないものが載っていた。
#
# 入れるもの: control plane の engine (scripts/)、 それが import する workspace
# (packages/)、 配信する portal の成果物 (dist)、 そして runtime-deps stage で production
# だけに絞った node_modules。
COPY --from=runtime-deps /app/node_modules /app/node_modules
COPY --from=runtime-deps /app/package.json /app/package.json
COPY packages /app/packages
COPY scripts /app/scripts
# scripts/local-play/ は採点カーネルを infrastructure/lib から import する (attack-detection /
# uptime-multi / phased-polling 等の scoring kind、 scoring-kernel、 stack-names)。 AWS 経路と
# ローカル経路で採点実装を二重に持たないための共有であって、 CDK を実行するわけではない。
# `lib/` だけで 3.9MB — `infrastructure/` 全体 (cdk.out を含めて 6.4GB) とは別物。
COPY infrastructure/lib /app/infrastructure/lib
COPY --from=build /app/apps/participant-portal/dist /app/apps/participant-portal/dist

# #3096: the upstream image creates users for its own purposes but does not
# make TenkaCloud's runtime identity an explicit contract. Give the local
# control plane a dedicated fixed UID/GID so compose, persisted-volume
# migration, and future image updates agree on the same non-root principal.
ARG TENKACLOUD_UID=10001
ARG TENKACLOUD_GID=10001
RUN addgroup -S -g "${TENKACLOUD_GID}" tenkacloud \
  && adduser -S -D -H -u "${TENKACLOUD_UID}" -G tenkacloud tenkacloud \
  && mkdir -p /data \
  && chown -R "${TENKACLOUD_UID}:${TENKACLOUD_GID}" /data

# [#2906 audit finding, round 2] No bind-host override needed: server.ts's
# default listener bind is already loopback-only (127.0.0.1), identical to
# the host/dev path — and correct here specifically because this container
# currently runs with `network_mode: host` (compose.local.yaml). #3097 tracks
# moving readiness/scoring onto an internal bridge and removing host mode.
ENV TENKACLOUD_LOCAL_DIR=/data
ENV TENKACLOUD_LOCAL_PORTAL_DIST=/app/apps/participant-portal/dist
ENV LOCAL_API_PORT=5175
VOLUME ["/data"]

# Defense-in-depth while #3097 removes the raw Docker socket entirely. Compose
# adds only the daemon socket's measured supplementary GID; the primary process
# identity stays this fixed non-root user. Do not remove this USER merely to
# work around a socket-permission mismatch — fix the socket GID preflight instead.
USER tenkacloud:tenkacloud

# Runs in the FOREGROUND as this container's PID 1 (not `up`'s host-oriented
# detach-and-track-by-PID model — see containerServe() in
# scripts/tenkacloud-local.ts) so `docker stop` / `docker compose down`
# deliver SIGTERM directly to it, which is what stops every running
# per-problem container and persists state before exit.
ENTRYPOINT ["bun", "run", "scripts/tenkacloud-local.ts", "container-serve"]
