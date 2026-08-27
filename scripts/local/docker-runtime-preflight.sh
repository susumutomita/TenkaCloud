#!/usr/bin/env sh
# Start-only preflight for the Docker participant path (`make local`).
#
# Source-safe: defines functions only. docker-launcher.sh calls
# `tenkacloud_local_start_preflight` immediately after the shared Docker
# prerequisites and before the problem catalog fetch / control-plane build.
# Cleanup/status deliberately do NOT call this file: a full disk or disabled
# Desktop host networking must never block `make local-down`.

TENKACLOUD_DOCKER_DISK_USED_PERCENT=""
TENKACLOUD_DOCKER_DISK_FREE_KB=""
TENKACLOUD_DOCKER_DESKTOP_SETTINGS=""

# Docker Desktop/Colima/native Linux differ in where the daemon filesystem
# lives. A throwaway busybox container measures the daemon-side root filesystem
# instead of the host's df (which is the wrong disk on Docker Desktop/Colima).
#
# Returns 0 and sets *_PERCENT / *_FREE_KB when measured; 2 when the probe is
# unavailable. Unavailable is intentionally not a hard failure.
tenkacloud_probe_docker_vm_disk() {
  TENKACLOUD_DOCKER_DISK_USED_PERCENT=""
  TENKACLOUD_DOCKER_DISK_FREE_KB=""

  # Keep parsing inside busybox so the participant host still only requires
  # Docker + Compose. The output is exactly: <used-percent-number> <free-kib>.
  result=$(docker run --rm busybox sh -c \
    "df -Pk / | awk 'NR==2 {gsub(/%/, \"\", \$5); print \$5, \$4}'" \
    2>/dev/null) || return 2

  set -f
  # shellcheck disable=SC2086 # deliberate split of the two machine-generated fields.
  set -- $result
  set +f
  used=${1:-}
  free_kb=${2:-}
  case "$used" in
    '' | *[!0-9]*) return 2 ;;
  esac
  case "$free_kb" in
    '' | *[!0-9]*) return 2 ;;
  esac

  TENKACLOUD_DOCKER_DISK_USED_PERCENT=$used
  TENKACLOUD_DOCKER_DISK_FREE_KB=$free_kb
  return 0
}

tenkacloud_check_docker_vm_disk() {
  threshold=${TENKACLOUD_DOCKER_DISK_THRESHOLD_PERCENT:-90}
  case "$threshold" in
    '' | *[!0-9]*) threshold=90 ;;
  esac

  probe_status=0
  tenkacloud_probe_docker_vm_disk || probe_status=$?
  if [ "$probe_status" -ne 0 ]; then
    echo "⚠ Could not measure Docker VM disk usage before startup; continuing." >&2
    echo "  If startup later reports 'No space left on device', inspect: docker system df" >&2
    return 0
  fi

  free_mib=$((TENKACLOUD_DOCKER_DISK_FREE_KB / 1024))
  if [ "$TENKACLOUD_DOCKER_DISK_USED_PERCENT" -ge "$threshold" ]; then
    echo "Docker VM disk is ${TENKACLOUD_DOCKER_DISK_USED_PERCENT}% used (${free_mib} MiB free)." >&2
    echo "  This is at/above TenkaCloud's ${threshold}% startup threshold and can make" >&2
    echo "  problem containers fail with 'No space left on device'." >&2
    echo "  Inspect reclaimable data: docker system df" >&2
    echo "  Reclaim only what you intend (for example Docker Desktop disk cleanup or" >&2
    echo "  docker builder prune), then retry 'make local'. TenkaCloud will not prune automatically." >&2
    return 1
  fi

  echo "Docker VM disk: ${TENKACLOUD_DOCKER_DISK_USED_PERCENT}% used (${free_mib} MiB free)."
  return 0
}

# Detect whether the active daemon is Docker Desktop without confusing an
# installed-but-inactive Docker Desktop with Colima on the same Mac.
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

# Locate Docker Desktop's settings store when it is directly readable from this
# shell. Docker renamed settings.json to settings-store.json; keep the old name
# as a compatibility fallback. Missing/unreadable means "unknown", not disabled.
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

# Returns:
#   0 enabled / non-Desktop / safely unknown
#   1 Docker Desktop is positively detected with host networking disabled
#
tenkacloud_check_docker_desktop_host_networking() {
  tenkacloud_active_daemon_is_docker_desktop || return 0

  settings_status=0
  tenkacloud_docker_desktop_settings_path || settings_status=$?
  if [ "$settings_status" -ne 0 ]; then
    echo "⚠ Docker Desktop detected; TenkaCloud currently requires host networking." >&2
    echo "  The setting could not be read from this shell, so startup will continue." >&2
    echo "  Docker Desktop >=4.34: Settings > Resources > Network > Enable host networking." >&2
    return 0
  fi

  if grep -Eiq '"(hostNetworkingEnabled|HostNetworkingEnabled)"[[:space:]]*:[[:space:]]*false' \
    "$TENKACLOUD_DOCKER_DESKTOP_SETTINGS"; then
    echo "Docker Desktop host networking is disabled." >&2
    echo "  TenkaCloud's current local control plane uses network_mode: host." >&2
    echo "  Docker Desktop >=4.34: Settings > Resources > Network > Enable host networking," >&2
    echo "  select Apply and restart, then retry 'make local'." >&2
    return 1
  fi

  if grep -Eiq '"(hostNetworkingEnabled|HostNetworkingEnabled)"[[:space:]]*:[[:space:]]*true' \
    "$TENKACLOUD_DOCKER_DESKTOP_SETTINGS"; then
    echo "Docker Desktop host networking: enabled."
    return 0
  fi

  echo "⚠ Docker Desktop detected, but its host-networking setting was not recognizable." >&2
  echo "  Continuing; if the Portal is unreachable, verify Settings > Resources > Network > Enable host networking." >&2
  return 0
}

tenkacloud_local_start_preflight() {
  tenkacloud_check_docker_vm_disk || return 1
  tenkacloud_check_docker_desktop_host_networking || return 1
  return 0
}
