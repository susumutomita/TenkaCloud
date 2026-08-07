#!/usr/bin/env sh
# [Issue #2906 / ADR-055] Docker-only participant entry point for `make local`
# / `make local-down` / `make local-status`. Needs only Docker Engine + Docker
# Compose v2 on the host — no Bun, Node, or node_modules. The Bun/Vite
# developer path (unchanged) lives under `make local-dev`.
set -eu

repo_root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$repo_root"
export TENKACLOUD_REPO_ROOT="$repo_root"
COMPOSE="docker compose -f compose.local.yaml"
PORTAL_PORT="${LOCAL_API_PORT:-5175}"

require_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "Docker is required for 'make local' but was not found." >&2
    echo "  Install Docker: https://docs.docker.com/get-docker/" >&2
    echo "  Prefer the host Bun path instead? Run: make local-onboard && make local-dev" >&2
    exit 1
  fi
  if ! docker compose version >/dev/null 2>&1; then
    echo "Docker Compose v2 is required (the 'docker compose' plugin) but was not found." >&2
    echo "  See: https://docs.docker.com/compose/install/" >&2
    exit 1
  fi
  if ! docker info >/dev/null 2>&1; then
    echo "Docker is installed but its daemon is not reachable." >&2
    echo "  Start Docker Desktop (or the docker service), then retry." >&2
    exit 1
  fi
}

# [Finding 2, #2906 audit] `problems/` self-heal must run HOST-side: the
# container has no `.git` history for it (only the `problems/` working tree
# is bind-mounted, read-only, per the Dockerfile/catalog-loader.ts
# rationale), so this is the one place that can fetch it. Mirrors
# `make local-onboard`'s consent-before-install UX (never installs anything
# without asking; --yes / non-interactive requires explicit opt-in).
ensure_problems_submodule() {
  if [ -d "$repo_root/problems/challenges" ] && [ -n "$(ls -A "$repo_root/problems/challenges" 2>/dev/null)" ]; then
    return 0
  fi
  echo "problems/ catalog is empty — fetching it: git submodule update --init problems"
  if [ "${YES:-0}" = "1" ]; then
    git submodule update --init problems
    return 0
  fi
  if [ -t 0 ] && [ -z "${CI:-}" ]; then
    printf 'Fetch it now? [y/N] '
    read -r reply
    case "$reply" in
      y | Y | yes | YES) git submodule update --init problems ;;
      *)
        echo "  Manual: git submodule update --init problems" >&2
        exit 1
        ;;
    esac
  else
    echo "  Non-interactive run: re-run with YES=1, or manually: git submodule update --init problems" >&2
    exit 1
  fi
}

wait_for_portal() {
  deadline=$(($(date +%s) + 120))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if curl -sf --max-time 3 "http://127.0.0.1:${PORTAL_PORT}/healthz" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

cmd_up() {
  if [ -n "${PROBLEM:-}" ]; then
    echo "Note: PROBLEM=<id> pre-start is not yet supported on the Docker path (#2906 follow-up)." >&2
    echo "  Every problem starts on demand from the Portal instead." >&2
  fi
  require_docker
  ensure_problems_submodule
  $COMPOSE build
  $COMPOSE up -d
  echo "Waiting for the Participant Portal to answer..."
  if wait_for_portal; then
    echo "TenkaCloud local play is up: http://127.0.0.1:${PORTAL_PORT}"
  else
    echo "The Participant Portal did not answer within the startup window." >&2
    echo "Check the logs: docker compose -f compose.local.yaml logs local" >&2
    exit 1
  fi
}

# [Finding 1, #2906 audit] Two independent reclaim paths, not one:
#  1. Graceful, in-container `down` (same code as `tenkacloud local down` on
#     the host) — stops every per-problem container it owns AND clears
#     persisted progress. Best-effort: skipped silently if the control-plane
#     container already died (crash, OOM, a manual `docker kill`).
#  2. A host-side sweep by container name, run UNCONDITIONALLY — every
#     per-problem container/network this platform starts is named with the
#     `tc-local-` compose-project prefix (scripts/local-play/docker-adapter.ts),
#     so this reclaims orphans left behind specifically when step 1 could not
#     run, without depending on the control-plane container being alive.
# `compose down -v` unconditionally removes the control-plane's own named
# volume last, so "clear all progress" holds even when step 1 was skipped.
cmd_down() {
  require_docker
  $COMPOSE exec -T local bun run scripts/tenkacloud-local.ts down 2>/dev/null || true
  orphans=$(docker ps -aq --filter "name=tc-local-" 2>/dev/null || true)
  if [ -n "$orphans" ]; then
    echo "Reclaiming per-problem containers the control plane could not stop itself..."
    echo "$orphans" | xargs -r docker rm -f >/dev/null 2>&1 || true
  fi
  orphan_networks=$(docker network ls --filter "name=tc-local-" -q 2>/dev/null || true)
  if [ -n "$orphan_networks" ]; then
    echo "$orphan_networks" | xargs -r docker network rm >/dev/null 2>&1 || true
  fi
  $COMPOSE down --remove-orphans -v
  echo "Local play stopped and progress cleared."
}

cmd_status() {
  require_docker
  if $COMPOSE exec -T local bun run scripts/tenkacloud-local.ts status 2>/dev/null; then
    return 0
  fi
  echo "Local play is not running (or not reachable)." >&2
  exit 1
}

case "${1:-}" in
  up) cmd_up ;;
  down) cmd_down ;;
  status) cmd_status ;;
  *)
    echo "Usage: $0 <up|down|status>" >&2
    exit 1
    ;;
esac
