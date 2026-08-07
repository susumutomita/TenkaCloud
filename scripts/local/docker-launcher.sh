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

# [Finding 5, #2906 audit] Polls the CONTAINER's own compose healthcheck via
# `docker inspect` rather than curl-ing the published port from the host —
# `curl` is not one of this launcher's stated prerequisites (Docker + Compose
# only), and a curl-less host was silently misreported as "did not answer"
# even when the stack was actually healthy.
container_health() {
  docker inspect -f '{{.State.Health.Status}}' tenkacloud-local 2>/dev/null || echo "unknown"
}

wait_for_portal() {
  deadline=$(($(date +%s) + 120))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    [ "$(container_health)" = "healthy" ] && return 0
    sleep 2
  done
  return 1
}

# [#2906 round-2 audit] `network_mode: host` (compose.local.yaml) is what makes the
# container's OWN 127.0.0.1 the same as the host's — but on Docker Desktop
# (macOS/Windows) host networking is an opt-in Settings > Resources > Network toggle,
# off by default, and requires Desktop >=4.34. When it is not enabled, the container
# still starts and its INTERNAL healthcheck (which runs inside that same container,
# so it always sees its own loopback regardless of host networking) still reports
# "healthy" — but the host genuinely cannot reach the published address, which is
# exactly the "healthy but unreachable" false-success `container_health` alone cannot
# distinguish from a real success. This probes from the HOST side instead, using
# whichever of curl/wget happens to be present (best-effort only — neither is a
# stated prerequisite of this launcher, so their absence is not itself a failure).
#
# Three non-obvious requirements, each of which this probe got wrong at first and
# which a regression here would silently reintroduce:
#
#  1. NEVER go through an HTTP proxy. curl and wget both honour http_proxy for
#     http:// URLs even when the target is loopback, so in any shell that exports
#     a proxy without a matching no_proxy (ordinary in corporate environments)
#     an entirely healthy stack probes as unreachable — a deterministic false
#     failure on the participant entry point, made worse by the Docker Desktop
#     hint below then blaming the wrong thing. `--noproxy '*'` and the inline
#     `http_proxy= ...` overrides are what keep this pointed at real loopback.
#  2. Bound the wget path. `-T 5` bounds one attempt, not the command: GNU wget
#     retries up to 20 times with backoff, so a filtered/dropping route blocks
#     for minutes instead of failing. `--tries=1` is what actually bounds it.
#     (The common Docker-Desktop-misconfigured case is ECONNREFUSED, which fails
#     instantly either way — this is for the silent-drop case.)
#  3. Check WHAT answered, not merely that something did. Port 5175 is also the
#     host/dev path's own default (Vite, and `local-up`'s detached serve), so a
#     leftover dev process answers this probe happily while the container remains
#     invisible to the host — reporting success for the exact false-success case
#     this function exists to catch. Matching `"mode":"local"` from /healthz
#     (scripts/local-play/api.ts) confirms it is this engine answering, the same
#     standard scripts/onboard/codespaces-start-local.sh already applies via its
#     <title> grep.
host_reachable() {
  url="http://127.0.0.1:${PORTAL_PORT}/healthz"
  if command -v curl >/dev/null 2>&1; then
    curl -sf --noproxy '*' --max-time 5 "$url" 2>/dev/null | grep -q '"mode":"local"' && return 0
    return 1
  fi
  if command -v wget >/dev/null 2>&1; then
    # `--tries` is GNU wget only — busybox wget rejects it as an unknown option and
    # would exit non-zero, turning this fallback into the very false failure the
    # proxy fix above removes. Probe for it instead of assuming either flavour.
    wget_tries=""
    if wget --help 2>&1 | grep -q -- '--tries'; then wget_tries="--tries=1"; fi
    # shellcheck disable=SC2086 -- $wget_tries is a single flag or empty, by construction
    http_proxy= HTTP_PROXY= https_proxy= HTTPS_PROXY= all_proxy= ALL_PROXY= \
      wget -q -T 5 $wget_tries -O - "$url" 2>/dev/null | grep -q '"mode":"local"' && return 0
    return 1
  fi
  return 2 # neither tool available — genuinely unknown, not a failure signal
}

docker_desktop_host_networking_hint() {
  echo "  This usually means Docker Desktop's host networking is not enabled." >&2
  echo "  Docker Desktop >=4.34 required; enable it under Settings > Resources > Network," >&2
  echo "  then retry 'make local'. See: https://docs.docker.com/engine/network/drivers/host/" >&2
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
  if ! wait_for_portal; then
    echo "The Participant Portal did not answer within the startup window." >&2
    echo "Check the logs: docker compose -f compose.local.yaml logs local" >&2
    exit 1
  fi
  reachable_result=0
  host_reachable || reachable_result=$?
  if [ "$reachable_result" -eq 1 ]; then
    echo "The control-plane container reports healthy, but this host cannot reach" >&2
    echo "  http://127.0.0.1:${PORTAL_PORT} — the container is running without actually" >&2
    echo "  being visible to the host." >&2
    docker_desktop_host_networking_hint
    exit 1
  fi
  echo "TenkaCloud local play is up: http://127.0.0.1:${PORTAL_PORT}"
}

# [Finding 1, #2906 audit] Two independent reclaim paths, not one:
#  1. Graceful, in-container `down` (same code as `tenkacloud local down` on
#     the host) — stops every per-problem container it owns AND clears
#     persisted progress. Best-effort: skipped silently if the control-plane
#     container already died (crash, OOM, a manual `docker kill`).
#  2. A host-side sweep by container name, run UNCONDITIONALLY — every
#     per-problem container/network this platform starts is named with the
#     `tc-local-` compose-project prefix (scripts/local-play/manifest.ts),
#     so this reclaims orphans left behind specifically when step 1 could not
#     run, without depending on the control-plane container being alive.
# `compose down -v` unconditionally removes the control-plane's own named
# volume last, so "clear all progress" holds even when step 1 was skipped.
#
# [#2906 round-4 audit] The `tc-local-` prefix is shared with the host/dev path:
# `make local-dev` starts per-problem containers under the SAME names (they run
# the same engine), and its own session state lives on disk rather than in this
# stack's volume. Sweeping blindly while such a session exists would force-remove
# a running dev session's containers from underneath it, leave its state.json
# describing containers that no longer exist, leave its serve process alive, and
# leave its SQLite progress untouched — while printing "progress cleared". That
# is a destructive false success, so the sweep is skipped and the situation
# reported instead when a host/dev session is present.
host_dev_state_file() {
  printf '%s/state.json' "${TENKACLOUD_LOCAL_DIR:-$repo_root/.tenkacloud/local}"
}

cmd_down() {
  require_docker
  $COMPOSE exec -T local bun run scripts/tenkacloud-local.ts down 2>/dev/null || true
  if [ -f "$(host_dev_state_file)" ]; then
    $COMPOSE down --remove-orphans -v
    echo "Docker local play stopped and its progress volume removed."
    echo
    echo "A host/dev session (make local-dev) is also present — its problem containers," >&2
    echo "  its serve process, and its own saved progress were left untouched, because" >&2
    echo "  this command cannot tell them apart from the Docker path's by name alone." >&2
    echo "  Stop that one with: bun run scripts/tenkacloud-local.ts down" >&2
    return 0
  fi
  # [Finding 4, #2906 audit] Docker's --filter name= is an unanchored
  # substring match, not a prefix match — "^tc-local-" anchors it so this
  # never touches an unrelated container that merely CONTAINS that string
  # (e.g. a participant's own "btc-local-node"). Every per-problem container
  # this platform starts is actually named with this prefix
  # (scripts/local-play/manifest.ts's composeProjectName); nothing else may be.
  orphans=$(docker ps -aq --filter "name=^tc-local-" 2>/dev/null || true)
  if [ -n "$orphans" ]; then
    echo "Reclaiming per-problem containers the control plane could not stop itself..."
    echo "$orphans" | xargs -r docker rm -f >/dev/null 2>&1 || true
  fi
  orphan_networks=$(docker network ls --filter "name=^tc-local-" -q 2>/dev/null || true)
  if [ -n "$orphan_networks" ]; then
    echo "$orphan_networks" | xargs -r docker network rm >/dev/null 2>&1 || true
  fi
  $COMPOSE down --remove-orphans -v
  echo "Local play stopped and progress cleared."
}

# [Finding 3, #2906 audit] `tenkacloud-local.ts status` (the host/dev CLI
# command) requires state.json, which only `up`'s host-oriented detach path
# writes — containerServe() (the container's entrypoint) deliberately skips
# it, so exec-ing that command here always failed even while fully healthy.
# Probe the container's own compose healthcheck instead.
cmd_status() {
  require_docker
  case "$(container_health)" in
    healthy)
      status_reachable_result=0
      host_reachable || status_reachable_result=$?
      if [ "$status_reachable_result" -eq 1 ]; then
        echo "Local play's container reports healthy, but this host cannot reach" >&2
        echo "  http://127.0.0.1:${PORTAL_PORT}." >&2
        docker_desktop_host_networking_hint
        exit 1
      fi
      echo "Local play is running: http://127.0.0.1:${PORTAL_PORT}"
      return 0
      ;;
    starting)
      echo "Local play is starting up (health check not yet passing)." >&2
      exit 1
      ;;
    *)
      echo "Local play is not running (or not reachable)." >&2
      exit 1
      ;;
  esac
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
