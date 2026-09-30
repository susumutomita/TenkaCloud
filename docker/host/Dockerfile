# syntax=docker/dockerfile:1
#
# Host mode (`make host`) as one image, for a VM or container platform behind a
# TLS-terminating proxy (#3299). Build from the repository root with the catalog
# checked out:
#
#   docker build -f docker/host/Dockerfile -t tenkacloud-host .
#   docker run -v tenkacloud-host-data:/data \
#     -p 127.0.0.1:5174:5174 -p 127.0.0.1:5175:5175 tenkacloud-host \
#     --public-admin-origin https://admin.example.com \
#     --public-participant-origin https://play.example.com --behind-proxy
#
# Publish on loopback for a proxy on the same VM; only the proxy may reach these ports. The
# proxy must pass the original Host header (Caddy does by default; nginx needs
# `proxy_set_header Host $host`). State and the host login key live in /data.

FROM oven/bun:1.3.11-alpine AS build
WORKDIR /app
# Manifests first, so the install layer is keyed on the dependency tree. Every
# workspace in package.json needs its manifest for --frozen-lockfile.
COPY package.json bun.lock ./
COPY packages ./packages
COPY infrastructure/package.json ./infrastructure/
COPY apps/admin-console/package.json ./apps/admin-console/
COPY apps/application-admin-console/package.json ./apps/application-admin-console/
COPY apps/developer-portal/package.json ./apps/developer-portal/
COPY apps/participant-portal/package.json ./apps/participant-portal/
# --ignore-scripts for the same supply-chain reason as `make install`.
RUN --mount=type=cache,target=/root/.bun/install/cache \
      bun install --frozen-lockfile --ignore-scripts
COPY . .
RUN bun run build:host

# Runtime dependencies only: the root's own dependencies and packages/*, without the
# apps, infrastructure and build tooling (same approach as docker/local-control-plane).
FROM oven/bun:1.3.11-alpine AS runtime-deps
WORKDIR /app
COPY bun.lock ./
COPY package.json ./package.json.full
COPY packages ./packages
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
COPY --from=runtime-deps /app/node_modules /app/node_modules
COPY --from=runtime-deps /app/package.json /app/package.json
COPY packages /app/packages
COPY scripts/lib /app/scripts/lib
COPY scripts/local-host /app/scripts/local-host
COPY problems /app/problems
COPY --from=build /app/.tenkacloud/host-build /app/.tenkacloud/host-build

ENV HOME=/tmp/tenkacloud-home
ENV TENKACLOUD_HOST_REQUIRE_PUBLIC=1
# Host mode refuses a data directory other users can read (scripts/local-host/files.ts).
RUN test "$(id -u bun)" = "1000" \
    && mkdir -p /data \
    && chown bun:bun /data \
    && chmod 700 /data
VOLUME ["/data"]
USER bun
EXPOSE 5174 5175
# Public mode answers /healthz regardless of Host, so the check can use loopback.
HEALTHCHECK --interval=30s --timeout=5s \
  CMD wget -qO- http://127.0.0.1:5175/healthz >/dev/null || exit 1
ENTRYPOINT ["bun", "run", "scripts/local-host/main.ts", "--no-build", "--data", "/data"]
