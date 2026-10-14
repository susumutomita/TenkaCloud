# Disposable CI-only daemon namespace; no host configuration or runtime image changes.
FROM oven/bun:1.3.11-alpine AS bun
FROM docker:28.4-dind
RUN apk add --no-cache iproute2 libstdc++ libgcc
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY docker/host/network-lab-cgroup.mjs /usr/local/lib/network-lab-cgroup.mjs
