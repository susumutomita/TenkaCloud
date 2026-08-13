#!/usr/bin/env sh
# [Issue #2906] Docker-only participant entry point for `make local`
# / `make local-down` / `make local-status`. Needs only Docker Engine + Docker
# Compose v2 on the host — no Bun, Node, or node_modules. The Bun/Vite
# developer path (unchanged) lives under `make local-dev`.
set -eu

repo_root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$repo_root"
export TENKACLOUD_REPO_ROOT="$repo_root"
# [Issue #2963] compose project 名を固定する。
#
# 指定しないと compose はカレントディレクトリ名を project 名にする。このリポジトリは worktree を
# 常用するので、primary clone では `tenkacloud`、`.claude/worktrees/foo-abc123` からは
# `foo-abc123` になる。一方 container 名 (`tenkacloud-local`) と volume 名
# (`tenkacloud-local-data`) は compose.local.yaml で固定されているため、project だけが食い違い、
# 「volume は別 project の持ち物」警告と container 名衝突を必ず踏む。
#
# local play はホストに 1 つだけ在ればよいものなので、project 名も 1 つに固定するのが素直。
COMPOSE_PROJECT="tenkacloud-local"
COMPOSE="docker compose -p ${COMPOSE_PROJECT} -f compose.local.yaml"
CONTROL_PLANE_CONTAINER="tenkacloud-local"
PORTAL_PORT="${LOCAL_API_PORT:-5175}"

# Keep the participant launcher's Docker contract identical to `make doctor`.
# shellcheck source=scripts/local/docker-prerequisites.sh
. "$repo_root/scripts/local/docker-prerequisites.sh"

require_docker() {
  tenkacloud_require_docker "make local"
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
    # $wget_tries is a single flag or empty, by construction.
    # shellcheck disable=SC1007,SC2086
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

# [Issue #2963] 固定名 container が **別の compose project** の持ち物として既に存在する場合に
# 引き取る。
#
# project 名を固定した後でも、固定前に別ディレクトリから起動した container は残っている。
# compose はそれを自分のものと見なさないので、`up` は docker daemon の Conflict エラーをそのまま
# 出して終わる。生の Conflict ログからは何をすればいいか読み取れないので、ここで回収する。
#
# 消して困るものは container 側に無い: local play の状態は named volume
# `tenkacloud-local-data` に載っており、volume はここでは触らない。同じ image から作り直すだけ。
reclaim_foreign_control_plane_container() {
  existing_project=$(docker inspect \
    -f '{{index .Config.Labels "com.docker.compose.project"}}' \
    "$CONTROL_PLANE_CONTAINER" 2>/dev/null || true)
  # container が無い (= inspect が失敗) なら何もしない。通常の初回起動。
  [ -n "$existing_project" ] || return 0
  # 既に自分の project のものなら compose に任せる (再利用 / 作り直しは compose が判断する)。
  [ "$existing_project" != "$COMPOSE_PROJECT" ] || return 0

  echo "Found an existing '${CONTROL_PLANE_CONTAINER}' container from compose project" >&2
  echo "  '${existing_project}' (started from a different directory, e.g. another git worktree)." >&2
  echo "  Removing it and recreating under '${COMPOSE_PROJECT}'." >&2
  echo "  Your local play data is in the '${CONTROL_PLANE_CONTAINER}-data' volume and is kept." >&2
  if ! docker rm -f "$CONTROL_PLANE_CONTAINER" >/dev/null 2>&1; then
    echo "Could not remove the conflicting container '${CONTROL_PLANE_CONTAINER}'." >&2
    echo "  Remove it yourself and retry:" >&2
    echo "    docker rm -f ${CONTROL_PLANE_CONTAINER}" >&2
    echo "    make local" >&2
    exit 1
  fi
}

cmd_up() {
  if [ -n "${PROBLEM:-}" ]; then
    echo "Note: PROBLEM=<id> pre-start is not yet supported on the Docker path (#2906 follow-up)." >&2
    echo "  Every problem starts on demand from the Portal instead." >&2
  fi
  require_docker
  ensure_problems_submodule
  reclaim_foreign_control_plane_container
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
  if [ "$reachable_result" -eq 2 ]; then
    echo "The control-plane container is healthy, but host reachability was not verified" >&2
    echo "  because neither curl nor wget is installed." >&2
    echo "  Open http://127.0.0.1:${PORTAL_PORT} in a browser. If it does not load," >&2
    docker_desktop_host_networking_hint
    echo "TenkaCloud local play container is up (host reachability unverified): http://127.0.0.1:${PORTAL_PORT}"
    return 0
  fi
  echo "TenkaCloud local play is up and host-reachable: http://127.0.0.1:${PORTAL_PORT}"
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
# reported instead when a host/dev session is LIVE.
#
# [#2906 review] "Live" must mean live, not "state.json exists". A dev session
# that was kill -9'd, crashed, or lost to a reboot leaves that file behind, and
# treating the leftover as active would disable this crash-safe sweep from then
# on — the exact recovery path it exists to provide, silently switched off by a
# past unrelated crash. The Bun side already solves this with a recorded PID plus
# a processIdentity that is sha256("<pid>:<ps lstart>") (scripts/local-play/
# process-identity.ts), which rejects PID reuse; the check below reproduces that
# in POSIX shell rather than approximating it, because the launcher must not
# depend on Bun. Zombies count as dead, matching parseProcessObservation.
host_dev_state_file() {
  printf '%s/state.json' "${TENKACLOUD_LOCAL_DIR:-$repo_root/.tenkacloud/local}"
}

# Read one top-level string/number field out of state.json without a JSON parser.
host_dev_state_field() {
  sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\{0,1\}\([^,\"}]*\)\"\{0,1\}.*/\1/p" \
    "$(host_dev_state_file)" 2>/dev/null | head -n 1
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$1" | sha256sum | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    printf '%s' "$1" | shasum -a 256 | cut -d' ' -f1
  else
    return 1
  fi
}

host_dev_session_is_live() {
  [ -f "$(host_dev_state_file)" ] || return 1
  pid=$(host_dev_state_field pid)
  case "$pid" in
    '' | *[!0-9]*) return 1 ;; # missing or malformed — cannot be a live session
  esac
  observed=$(LC_ALL=C ps -p "$pid" -o stat= -o lstart= 2>/dev/null) || return 1
  [ -n "$observed" ] || return 1
  state=${observed%%[[:space:]]*}
  case "$state" in
    Z*) return 1 ;; # already exited, just not reaped
  esac
  start_time=$(printf '%s' "${observed#"$state"}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  recorded=$(host_dev_state_field processIdentity)
  # No recorded identity (older session) or no hashing tool: fall back to plain
  # liveness. That is weaker against PID reuse but still strictly better than
  # file existence, and it errs toward NOT destroying a possibly-live session.
  [ -n "$recorded" ] || return 0
  current=$(sha256_of "${pid}:${start_time}") || return 0
  [ "$current" = "$recorded" ]
}

cmd_down() {
  require_docker
  $COMPOSE exec -T local bun run scripts/tenkacloud-local.ts down 2>/dev/null || true
  if host_dev_session_is_live; then
    $COMPOSE down --remove-orphans -v
    echo "Docker local play stopped and its progress volume removed."
    echo
    echo "A host/dev session (make local-dev) is RUNNING — its problem containers," >&2
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
  #
  # [#2906 review] Plain `for` loops rather than `xargs`: each id is removed with
  # its own invocation, so one failure cannot abort the rest, and an empty list is
  # a no-op without depending on `xargs -r` (which is not in POSIX, so its
  # availability varies by implementation and version). The `-n` guards already
  # cover the empty case.
  orphans=$(docker ps -aq --filter "name=^tc-local-" 2>/dev/null || true)
  if [ -n "$orphans" ]; then
    echo "Reclaiming per-problem containers the control plane could not stop itself..."
    for orphan in $orphans; do
      docker rm -f "$orphan" >/dev/null 2>&1 || true
    done
  fi
  # [#2906 review] Volumes too, and they are the reason this whole branch exists.
  # A problem's own named volumes (e.g. wp-exposed-backup's db_data/wp_data) are
  # created under its `tc-local-<problemId>` compose project, so neither the
  # container sweep above nor the `$COMPOSE down -v` below — which only knows the
  # control-plane project in compose.local.yaml — reclaims them. Left behind, they
  # are silently reused by the next run, so a participant resumes a mutated
  # challenge while this command claims progress was cleared: a stale WordPress
  # database is exactly the state wp-exposed-backup's answer depends on.
  # Selected by the `com.docker.compose.project` label rather than by volume name,
  # so this does not depend on Compose's `<project>_<volume>` name mangling.
  # Must run AFTER the container sweep: a volume still in use cannot be removed.
  orphan_volumes=$(docker volume ls -q --filter "label=com.docker.compose.project" 2>/dev/null || true)
  for orphan_volume in $orphan_volumes; do
    volume_project=$(docker volume inspect \
      -f '{{index .Labels "com.docker.compose.project"}}' "$orphan_volume" 2>/dev/null || true)
    case "$volume_project" in
      tc-local-*) docker volume rm -f "$orphan_volume" >/dev/null 2>&1 || true ;;
    esac
  done
  orphan_networks=$(docker network ls --filter "name=^tc-local-" -q 2>/dev/null || true)
  if [ -n "$orphan_networks" ]; then
    for orphan_network in $orphan_networks; do
      docker network rm "$orphan_network" >/dev/null 2>&1 || true
    done
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
      if [ "$status_reachable_result" -eq 2 ]; then
        echo "Local play's container is healthy, but host reachability is unverified" >&2
        echo "  because neither curl nor wget is installed." >&2
        echo "Local play container is running (host reachability unverified): http://127.0.0.1:${PORTAL_PORT}"
        return 0
      fi
      echo "Local play is running and host-reachable: http://127.0.0.1:${PORTAL_PORT}"
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
