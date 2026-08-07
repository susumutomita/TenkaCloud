#!/usr/bin/env sh
# Codespaces postCreate entry point (.devcontainer/devcontainer.json).
#
# One script instead of a `cmd && cmd && cmd` chain, because the bootstrap step
# may install bun into ~/.bun/bin mid-run: a chained `bun run ...` in the SAME
# postCreate shell would not see it (PATH was resolved before the install) and
# the whole chain used to abort — leaving a Codespace with no dependencies and
# no problems/ submodule, where `make local` then failed on both.
set -eu

repo_root=$(cd "$(dirname "$0")/../.." && pwd)

sh "$repo_root/scripts/onboard/onboard-bootstrap.sh" --yes

# Pick up a bun the bootstrap just installed (no-op when bun already existed).
export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
export PATH="$BUN_INSTALL/bin:$PATH"

# Preflight (--yes) checks out the problems/ submodule and diagnoses Docker.
bun run "$repo_root/scripts/tenkacloud-onboard.ts" preflight --yes

# Agent CLIs (Claude Code + Codex) so `claude` / `codex` work for in-Codespace
# debugging out of the box. Best-effort: a registry outage must not brick the
# Codespace, so a failure only warns. Runs from $HOME so the repo .npmrc
# (ignore-scripts / min-release-age, aimed at project deps) does not alter the
# global install of these first-party CLIs.
(
  cd "$HOME" \
    && npm install -g @anthropic-ai/claude-code @openai/codex
) || echo "[codespaces-setup] WARN: agent CLI install failed — run manually: npm install -g @anthropic-ai/claude-code @openai/codex"

# Dependencies for every workspace — `make local-dev` needs vite for the portal.
make -C "$repo_root" install

# [#2906 round 2] Pre-build the participant control-plane image now, at container
# CREATE time, not at every container START. Without this, codespaces-start-local.sh's
# postStartCommand runs `make local` cold — a `docker compose build` (full workspace
# `bun install --frozen-lockfile` + Portal `vite build` inside the image, see
# docker/local-control-plane/Dockerfile) on top of the `docker compose up` + healthcheck
# wait that script's timeout was actually sized for — and reliably blows through its
# 120s deadline on a fresh Codespace with no Docker layer cache, surfacing as a false
# startup failure even though local play would have come up eventually. Docker layer
# caching persists across postCreate -> postStart within the same container/filesystem,
# so this makes that build a fast cache hit by the time postStart's `make local` needs
# it. Best-effort like the agent-CLI install above: Docker itself is preflighted by
# `tenkacloud-onboard.ts preflight` just above, but a transient build failure here must
# not brick Codespace creation — codespaces-start-local.sh still runs the real build (and
# fails loud) if this pre-warm did not stick.
(
  cd "$repo_root" \
    && TENKACLOUD_REPO_ROOT="$repo_root" docker compose -f compose.local.yaml build
) || echo "[codespaces-setup] WARN: pre-building the local-play image failed — 'make local' will build it (slower) on first start."
