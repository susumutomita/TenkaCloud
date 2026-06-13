# TenkaCloud deploy toolchain image.
#
# Goal: a host with ONLY Docker installed can run `make deploy-docker` / `make destroy-docker`
# with no bun, node, or AWS CLI on the host. This image carries the exact toolchain the
# deploy path needs and runs the repo from inside the container. The repo is bind-mounted
# at /workspace by docker-compose.yml, so local working changes deploy as-is — the image
# deliberately does NOT COPY the source, only the toolchain.

# Node 24 matches package.json "engines": { "node": ">=24" }. The CDK CLI shebang is
# `#!/usr/bin/env node` and NodejsFunction bundles Lambdas with local esbuild, so a real
# Node runtime must sit alongside Bun.
FROM node:24-bookworm-slim

# Bun is pinned to package.json "packageManager": "bun@1.3.11" so the container resolves
# the committed bun.lock exactly like CI does.
ARG BUN_VERSION=1.3.11

# Base packages: certificates + curl/unzip for the installers below, git for the bun
# workspace, bash for the entrypoint, make to drive the inner targets, and gosu so the
# entrypoint can drop from root to the host user's uid at runtime (docker/entrypoint.sh).
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       ca-certificates curl unzip git bash make gosu \
  && rm -rf /var/lib/apt/lists/*

# Bun (pinned). Installed to a world-readable path so it stays runnable after the
# entrypoint drops from root to the (arbitrary) host uid; the binary lands in /opt/bun/bin.
ENV BUN_INSTALL=/opt/bun
ENV PATH=/opt/bun/bin:$PATH
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" \
  && bun --version \
  && chmod -R a+rx /opt/bun

# AWS CLI v2 (architecture-aware: x86_64 / aarch64). The deploy scripts
# (tenkacloud-lite.ts / install.sh / cleanup.sh) shell out to `aws` for CFn outputs,
# STS identity, and S3 source upload.
RUN arch="$(uname -m)" \
  && curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${arch}.zip" -o /tmp/awscliv2.zip \
  && unzip -q /tmp/awscliv2.zip -d /tmp \
  && /tmp/aws/install \
  && aws --version \
  && rm -rf /tmp/aws /tmp/awscliv2.zip

WORKDIR /workspace

# HOME for the runtime user. The container starts as root only long enough to chown the
# volume-backed node_modules + this dir to the host uid, then gosu-drops to that uid
# (docker/entrypoint.sh). docker-compose.yml mounts the host ~/.aws here read-only.
ENV HOME=/home/tenkacloud
RUN mkdir -p /home/tenkacloud

# Install deps into the (volume-backed) node_modules, then exec the requested command.
COPY docker/entrypoint.sh /usr/local/bin/tenkacloud-entrypoint
RUN chmod +x /usr/local/bin/tenkacloud-entrypoint
ENTRYPOINT ["/usr/local/bin/tenkacloud-entrypoint"]
CMD ["make", "deploy"]
