#!/usr/bin/env sh
# Docker Desktop host-networking preflight for the Docker-only participant path.
# Source-safe: defines functions only. The launcher calls it only from `up`, so
# disk pressure / a disabled Desktop setting never blocks `local-down`/status.

TENKACLOUD_DOCKER_DESKTOP_SETTINGS=""

# #3096 extends the same start-only preflight with a daemon-socket GID check so
# the control plane can stay non-root without making the socket world-writable.
# shellcheck source=scripts/local/docker-socket-gid-preflight.sh
. "$TENKACLOUD_REPO_ROOT/scripts/local/docker-socket-gid-preflight.sh"

# Detect the ACTIVE daemon, not merely whether Docker Desktop happens to be
# installed. This avoids false failures on Macs using Colima with a dormant
# Docker Desktop settings file still present.
tenkacloud_active_daemon_is_docker_desktop() {
  operating_system=$(docker info --format '{{.OperatingSystem}}' 2>/dev/null || true)
  case "$operating_system" in
    *Docker\ Desktop*) return 0 ;;
  esac
  context_name=$(docker context show 2>/dev/null || true)
  case "$context_name" in
    desktop-* | docker-desktop) return 0 ;;
  esac
  return 1
}

# Docker renamed settings.json to settings-store.json. Missing/unreadable is
# intentionally "unknown" rather than "disabled": managed Desktop installs
# may hide this file while host networking is actually enabled.
tenkacloud_docker_desktop_settings_path() {
  TENKACLOUD_DOCKER_DESKTOP_SETTINGS=""
  case "$(uname -s 2>/dev/null || true)" in
    Darwin)
      for candidate in \
        "$HOME/Library/Group Containers/group.com.docker/settings-store.json" \
        "$HOME/Library/Group Containers/group.com.docker/settings.json"
      do
        if [ -r "$candidate" ]; then
          TENKACLOUD_DOCKER_DESKTOP_SETTINGS=$candidate
          return 0
        fi
      done
      ;;
    Linux)
      candidate="$HOME/.docker/desktop/settings-store.json"
      if [ -r "$candidate" ]; then
        TENKACLOUD_DOCKER_DESKTOP_SETTINGS=$candidate
        return 0
      fi
      ;;
  esac
  return 2
}

# Returns 0 when enabled / not Desktop / unknown, and 1 only when Docker
# Desktop is positively identified and its setting is explicitly false.
tenkacloud_check_docker_desktop_host_networking() {
  tenkacloud_active_daemon_is_docker_desktop || return 0

  settings_status=0
  tenkacloud_docker_desktop_settings_path || settings_status=$?
  if [ "$settings_status" -ne 0 ]; then
    echo "Warning: Docker Desktop detected; TenkaCloud currently requires host networking." >&2
    echo "  The Desktop setting could not be read from this shell, so startup will continue." >&2
    echo "  If the Portal is unreachable, verify Docker Desktop >=4.34:" >&2
    echo "  Settings > Resources > Network > Enable host networking." >&2
    return 0
  fi

  if grep -Eiq '"(hostNetworkingEnabled|HostNetworkingEnabled)"[[:space:]]*:[[:space:]]*false' \
    "$TENKACLOUD_DOCKER_DESKTOP_SETTINGS"; then
    echo "Docker Desktop host networking is disabled." >&2
    echo "  TenkaCloud's current local control plane uses network_mode: host." >&2
    echo "  Docker Desktop >=4.34: Settings > Resources > Network > Enable host networking," >&2
    echo "  select Apply and restart, then retry 'make local'." >&2
    echo "  #3097 tracks removing this host-network dependency entirely." >&2
    return 1
  fi

  if grep -Eiq '"(hostNetworkingEnabled|HostNetworkingEnabled)"[[:space:]]*:[[:space:]]*true' \
    "$TENKACLOUD_DOCKER_DESKTOP_SETTINGS"; then
    echo "Docker Desktop host networking: enabled."
    return 0
  fi

  echo "Warning: Docker Desktop detected, but its host-networking setting was not recognizable." >&2
  echo "  Continuing; the existing post-start host reachability probe remains the fallback." >&2
  return 0
}

# The launcher already calls this only on `up`. Keep the public function name
# introduced by #3095, and layer #3096's non-root socket permission check after
# the networking check so downstream stacked branches need no launcher rewrite.
tenkacloud_preflight_docker_desktop_host_networking() {
  tenkacloud_check_docker_desktop_host_networking || return 1
  tenkacloud_preflight_docker_socket_gid || return 1
}
