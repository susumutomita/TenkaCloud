#!/usr/bin/env sh
# #3096: resolve the active Docker daemon socket's numeric GID before the
# non-root local control plane starts. Source-safe; the launcher calls this
# only on the `up` path.

TENKACLOUD_DOCKER_SOCKET_GID=""

# Inspect the socket from the daemon-side filesystem. On Docker Desktop the
# bind source used by sibling containers is /var/run/docker.sock inside the VM,
# not necessarily the host proxy socket reported to the macOS shell.
tenkacloud_probe_docker_socket_gid() {
  TENKACLOUD_DOCKER_SOCKET_GID=""
  socket=${TENKACLOUD_DOCKER_SOCKET:-/var/run/docker.sock}
  gid=$(docker run --rm -v "${socket}:/tenkacloud-docker.sock:ro" busybox \
    stat -c '%g' /tenkacloud-docker.sock 2>/dev/null) || return 1
  case "$gid" in
    '' | *[!0-9]*) return 1 ;;
  esac
  TENKACLOUD_DOCKER_SOCKET_GID=$gid
  export TENKACLOUD_DOCKER_SOCKET_GID
  return 0
}

tenkacloud_preflight_docker_socket_gid() {
  if ! tenkacloud_probe_docker_socket_gid; then
    echo "Could not determine the Docker daemon socket group safely." >&2
    echo "  TenkaCloud will not fall back to root or make the socket world-writable." >&2
    echo "  Active socket: ${TENKACLOUD_DOCKER_SOCKET:-/var/run/docker.sock}" >&2
    echo "  Verify the active Docker context/socket, then retry 'make local'." >&2
    return 1
  fi
  echo "Docker socket supplementary GID: ${TENKACLOUD_DOCKER_SOCKET_GID}."
}
