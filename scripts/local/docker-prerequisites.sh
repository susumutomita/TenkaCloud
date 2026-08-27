#!/usr/bin/env sh
# Shared Docker prerequisite checks for the participant path.
#
# This file is source-safe: it defines functions and does not change shell
# options, directories, or process state by itself. Both `make local` and the
# Bun-free `make doctor` source it so they cannot drift on the Docker CLI,
# Compose v2, daemon, or active-context socket requirements.

TENKACLOUD_DOCKER_SOCKET_ERROR_KIND=""
TENKACLOUD_DOCKER_ENDPOINT=""

tenkacloud_docker_cli_version() {
  command -v docker >/dev/null 2>&1 || return 1
  docker --version 2>/dev/null
}

tenkacloud_docker_compose_version() {
  command -v docker >/dev/null 2>&1 || return 1
  docker compose version 2>/dev/null
}

tenkacloud_docker_daemon_ready() {
  command -v docker >/dev/null 2>&1 || return 1
  docker info >/dev/null 2>&1
}

TENKACLOUD_RUNNING_CONTAINERD_VERSION=""
TENKACLOUD_ONDISK_CONTAINERD_VERSION=""

# Detect a Docker daemon still running a containerd from before a package
# upgrade.
#
# The failing case (#3088): apt upgrades the `containerd.io` package — which
# ships both `containerd` and the `containerd-shim-runc-v2` binary — but the
# daemon service is never restarted. This is common with the rootless,
# user-managed `docker.service`, which package upgrades do not restart (unlike
# the system service). The stale in-memory containerd then execs the freshly
# upgraded on-disk shim on every `docker run`; the two speak mismatched ttrpc
# and every container fails at start with "failed to create shim". `make doctor`
# otherwise reports all green because the CLI, Compose, socket, and
# `docker info` all still answer.
#
# The comparison is on CONTAINERD, not dockerd. `containerd.io` versions and
# upgrades independently of `docker-ce` (which carries dockerd), and a
# containerd-only upgrade is a common trigger — one that leaves dockerd
# untouched, so a dockerd-vs-dockerd check would miss it. This reads the
# containerd the daemon is RUNNING (from `docker version`) against the ON-DISK
# `containerd` binary.
#
# Skipped (returns 2) when either version cannot be read — e.g. Docker Desktop,
# where the daemon and its containerd live in a VM the host cannot inspect and
# Docker Desktop manages its own restarts, so this case does not apply.
#
# Returns: 0 = versions read and DIFFER (stale; restart needed),
#          1 = versions read and match (healthy),
#          2 = cannot decide (a version was unreadable).
tenkacloud_docker_daemon_stale() {
  TENKACLOUD_RUNNING_CONTAINERD_VERSION=""
  TENKACLOUD_ONDISK_CONTAINERD_VERSION=""
  command -v docker >/dev/null 2>&1 || return 2
  command -v containerd >/dev/null 2>&1 || return 2

  TENKACLOUD_RUNNING_CONTAINERD_VERSION=$(docker version --format '{{range .Server.Components}}{{if eq .Name "containerd"}}{{.Version}}{{end}}{{end}}' 2>/dev/null || true)
  # `containerd --version` prints e.g. "containerd containerd v2.3.3 <commit>".
  # Take the third word with POSIX built-ins only, so this needs no awk/tr.
  tenkacloud_containerd_version_line=$(containerd --version 2>/dev/null || true)
  # Disable pathname expansion so a version string is never glob-expanded, then
  # word-split. `set --` here touches only this function's positional params.
  set -f
  # shellcheck disable=SC2086 # deliberate word-splitting to pick the 3rd field.
  set -- $tenkacloud_containerd_version_line
  set +f
  # `${3:-}` keeps this safe under `set -u` when the line had fewer than 3 words.
  TENKACLOUD_ONDISK_CONTAINERD_VERSION=${3:-}

  [ -n "$TENKACLOUD_RUNNING_CONTAINERD_VERSION" ] || return 2
  [ -n "$TENKACLOUD_ONDISK_CONTAINERD_VERSION" ] || return 2

  [ "$TENKACLOUD_RUNNING_CONTAINERD_VERSION" != "$TENKACLOUD_ONDISK_CONTAINERD_VERSION" ]
}

# Resolve the Unix socket the ACTIVE Docker context uses.
#
# The control-plane container bind-mounts this socket to start problem
# containers. A remote/tcp/ssh context cannot work because there is no local
# socket to mount and bind paths would be resolved on the remote daemon host.
# macOS is special: the daemon is in a VM, so the bind source must be the
# daemon-side /var/run/docker.sock rather than the host proxy socket reported by
# Docker Desktop, Colima, or Rancher Desktop.
tenkacloud_resolve_docker_socket() {
  TENKACLOUD_DOCKER_SOCKET_ERROR_KIND=""
  TENKACLOUD_DOCKER_ENDPOINT=""

  # Explicit override is the escape hatch for Docker configurations this
  # resolver does not know yet. Preserve the existing launcher contract.
  if [ -n "${TENKACLOUD_DOCKER_SOCKET:-}" ]; then
    export TENKACLOUD_DOCKER_SOCKET
    return 0
  fi

  TENKACLOUD_DOCKER_ENDPOINT=$(docker context inspect -f '{{.Endpoints.docker.Host}}' 2>/dev/null || true)
  if [ -z "$TENKACLOUD_DOCKER_ENDPOINT" ]; then
    TENKACLOUD_DOCKER_ENDPOINT="${DOCKER_HOST:-unix:///var/run/docker.sock}"
  fi

  case "$TENKACLOUD_DOCKER_ENDPOINT" in
    unix://*)
      TENKACLOUD_DOCKER_SOCKET=${TENKACLOUD_DOCKER_ENDPOINT#unix://}
      ;;
    *)
      TENKACLOUD_DOCKER_SOCKET_ERROR_KIND="remote"
      return 1
      ;;
  esac

  if [ "$(uname -s)" = "Darwin" ]; then
    TENKACLOUD_DOCKER_SOCKET=/var/run/docker.sock
    export TENKACLOUD_DOCKER_SOCKET
    return 0
  fi

  if [ ! -S "$TENKACLOUD_DOCKER_SOCKET" ]; then
    TENKACLOUD_DOCKER_SOCKET_ERROR_KIND="missing"
    return 1
  fi
  export TENKACLOUD_DOCKER_SOCKET
}

tenkacloud_resolve_docker_socket_gid() {
  if [ -n "${TENKACLOUD_DOCKER_SOCKET_GID:-}" ]; then
    case "$TENKACLOUD_DOCKER_SOCKET_GID" in
      *[!0-9]*) return 1 ;;
    esac
    export TENKACLOUD_DOCKER_SOCKET_GID
    return 0
  fi
  TENKACLOUD_DOCKER_SOCKET_GID=""
  if [ "$(uname -s)" = "Darwin" ]; then
    # The source path is resolved inside the Desktop/Colima VM, not on macOS.
    # Their socket proxy is exposed to containers through supplementary group 0.
    TENKACLOUD_DOCKER_SOCKET_GID=0
  elif stat -c '%g' "$TENKACLOUD_DOCKER_SOCKET" >/dev/null 2>&1; then
    TENKACLOUD_DOCKER_SOCKET_GID=$(stat -c '%g' "$TENKACLOUD_DOCKER_SOCKET")
  elif stat -f '%g' "$TENKACLOUD_DOCKER_SOCKET" >/dev/null 2>&1; then
    TENKACLOUD_DOCKER_SOCKET_GID=$(stat -f '%g' "$TENKACLOUD_DOCKER_SOCKET")
  else
    return 1
  fi
  case "$TENKACLOUD_DOCKER_SOCKET_GID" in
    '' | *[!0-9]*) return 1 ;;
  esac
  export TENKACLOUD_DOCKER_SOCKET_GID
}

tenkacloud_print_docker_socket_guidance() {
  entrypoint=${1:-make local}
  case "$TENKACLOUD_DOCKER_SOCKET_ERROR_KIND" in
    remote)
      echo "'$entrypoint' needs a local Docker daemon reachable over a Unix socket," >&2
      echo "  but the active Docker context uses: $TENKACLOUD_DOCKER_ENDPOINT" >&2
      echo "  The control plane bind-mounts the daemon socket to start problem" >&2
      echo "  containers, and a remote daemon would also resolve this repository's" >&2
      echo "  paths on the wrong machine." >&2
      echo "  Switch to a local context (e.g. docker context use default), or use" >&2
      echo "  the host developer path instead: make local-onboard && make local-dev" >&2
      ;;
    missing)
      echo "The active Docker context points at $TENKACLOUD_DOCKER_SOCKET," >&2
      echo "  but no socket exists there. Start the daemon for this context, or" >&2
      echo "  switch contexts (docker context ls) and retry." >&2
      ;;
  esac
}

tenkacloud_docker_operating_system() {
  docker info --format '{{.OperatingSystem}}' 2>/dev/null
}

tenkacloud_is_docker_desktop() {
  tenkacloud_operating_system=$(tenkacloud_docker_operating_system) || return 1
  case "$tenkacloud_operating_system" in
    *Docker\ Desktop* | *docker\ desktop*) return 0 ;;
    *) return 1 ;;
  esac
}

# Measured minimum needed to materialize the Docker-only control-plane image.
# Problem images and BuildKit cache require additional space.
TENKACLOUD_CONTROL_PLANE_DISK_FLOOR_BYTES=755000000
TENKACLOUD_DOCKER_DISK_AVAILABLE_BYTES=""
TENKACLOUD_DOCKER_DISK_ERROR_KIND=""

tenkacloud_probe_docker_disk() {
  TENKACLOUD_DOCKER_DISK_AVAILABLE_BYTES=""
  TENKACLOUD_DOCKER_DISK_ERROR_KIND=""
  tenkacloud_disk_output=$(docker run --rm busybox df -P / 2>/dev/null) || {
    TENKACLOUD_DOCKER_DISK_ERROR_KIND="probe-failed"
    return 1
  }
  tenkacloud_disk_available_kib=$(
    printf '%s\n' "$tenkacloud_disk_output" |
      awk '$NF == "/" && $4 ~ /^[0-9]+$/ { print $4; exit }'
  )
  case "$tenkacloud_disk_available_kib" in
    '' | *[!0-9]*)
      TENKACLOUD_DOCKER_DISK_ERROR_KIND="unparseable"
      return 1
      ;;
  esac
  TENKACLOUD_DOCKER_DISK_AVAILABLE_BYTES=$((tenkacloud_disk_available_kib * 1024))
  export TENKACLOUD_DOCKER_DISK_AVAILABLE_BYTES
}

# Returns 0=sufficient, 1=below floor, 2=probe unavailable.
tenkacloud_docker_disk_meets_floor() {
  tenkacloud_disk_floor=${1:-$TENKACLOUD_CONTROL_PLANE_DISK_FLOOR_BYTES}
  if ! tenkacloud_probe_docker_disk; then
    return 2
  fi
  [ "$TENKACLOUD_DOCKER_DISK_AVAILABLE_BYTES" -ge "$tenkacloud_disk_floor" ]
}

tenkacloud_require_docker() {
  entrypoint=${1:-make local}
  if ! tenkacloud_docker_cli_version >/dev/null; then
    echo "Docker is required for '$entrypoint' but was not found." >&2
    echo "  Install Docker: https://docs.docker.com/get-docker/" >&2
    echo "  Prefer the host Bun path instead? Run: make local-onboard && make local-dev" >&2
    return 1
  fi
  if ! tenkacloud_docker_compose_version >/dev/null; then
    echo "Docker Compose v2 is required (the 'docker compose' plugin) but was not found." >&2
    echo "  See: https://docs.docker.com/compose/install/" >&2
    return 1
  fi
  if ! tenkacloud_docker_daemon_ready; then
    echo "Docker is installed but its daemon is not reachable." >&2
    echo "  Start Docker Desktop (or the docker service), then retry." >&2
    return 1
  fi
  if ! tenkacloud_resolve_docker_socket; then
    tenkacloud_print_docker_socket_guidance "$entrypoint"
    return 1
  fi
  if ! tenkacloud_resolve_docker_socket_gid; then
    echo "Could not determine the Docker socket group for $TENKACLOUD_DOCKER_SOCKET." >&2
    echo "  The non-root control plane needs that supplementary GID to reach Docker." >&2
    return 1
  fi
}
