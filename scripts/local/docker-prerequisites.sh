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
}
