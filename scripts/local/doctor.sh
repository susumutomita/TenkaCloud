#!/usr/bin/env sh
# Participant prerequisite and resource diagnosis for `make local`.
#
# Host requirements intentionally match the Docker-only participant path:
# Git, Make, Docker Engine, Docker Compose v2, an initialized problem catalog,
# and a usable local Docker daemon/socket. Bun, Node, and node_modules belong to
# the separate developer path (`make doctor-dev` / `make local-onboard`).
set -u

repo_root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$repo_root" || exit 1

# shellcheck source=scripts/local/docker-prerequisites.sh
. "$repo_root/scripts/local/docker-prerequisites.sh"

doctor_profile=""
doctor_probe_disk=0

doctor_usage() {
  cat <<'EOF'
Usage: make doctor [PROFILE=minimum|recommended|full] [PROBE_DISK=1]

Checks the Docker-only participant prerequisites used by `make local`.
PROBE_DISK=1 additionally pulls busybox to inspect free space in the Docker VM.
For the Bun/Vite developer path, run `make doctor-dev` or `make local-onboard`.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --profile)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        echo "--profile needs a value (minimum, recommended, or full)" >&2
        exit 2
      fi
      doctor_profile=$2
      shift 2
      ;;
    --probe-disk)
      doctor_probe_disk=1
      shift
      ;;
    --help | -h)
      doctor_usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      doctor_usage >&2
      exit 2
      ;;
  esac
done

case "$doctor_profile" in
  "" | minimum | recommended | full) ;;
  *)
    echo "Unknown profile \"$doctor_profile\" (expected minimum, recommended, or full)" >&2
    exit 2
    ;;
esac

doctor_failures=0

doctor_ok() {
  printf '  ✓ %s — %s\n' "$1" "$2"
}

doctor_fail() {
  printf '  ✗ %s — %s\n' "$1" "$2"
  doctor_failures=$((doctor_failures + 1))
}

doctor_skip() {
  printf '  · %s — %s\n' "$1" "$2"
}

doctor_first_line() {
  sed -n '1p'
}

echo "TenkaCloud participant prerequisites (Docker-only):"

if command -v git >/dev/null 2>&1 && doctor_version=$(git --version 2>/dev/null); then
  doctor_ok "Git" "$(printf '%s\n' "$doctor_version" | doctor_first_line)"
else
  doctor_fail "Git" "not installed; install Git before cloning or updating the problem catalog"
fi

if command -v make >/dev/null 2>&1 && doctor_version=$(make --version 2>/dev/null); then
  doctor_ok "Make" "$(printf '%s\n' "$doctor_version" | doctor_first_line)"
else
  doctor_fail "Make" "not installed; this entry point is normally run through make"
fi

if [ -d "$repo_root/problems/challenges" ] &&
  [ -n "$(ls -A "$repo_root/problems/challenges" 2>/dev/null)" ]; then
  doctor_ok "problems/ catalog" "initialized"
else
  doctor_fail "problems/ catalog" "not initialized"
  echo "      Next: git submodule update --init problems"
fi

doctor_has_docker=0
doctor_daemon_ready=0
if doctor_version=$(tenkacloud_docker_cli_version); then
  doctor_has_docker=1
  doctor_ok "Docker CLI" "$(printf '%s\n' "$doctor_version" | doctor_first_line)"
else
  doctor_fail "Docker CLI" "not installed"
  echo "      Next: install Docker from https://docs.docker.com/get-docker/"
fi

if [ "$doctor_has_docker" -eq 1 ]; then
  if doctor_version=$(tenkacloud_docker_compose_version); then
    doctor_ok "Docker Compose v2" "$(printf '%s\n' "$doctor_version" | doctor_first_line)"
  else
    doctor_fail "Docker Compose v2" "the 'docker compose' plugin did not answer"
    echo "      Next: install it from https://docs.docker.com/compose/install/"
  fi

  if tenkacloud_docker_daemon_ready; then
    doctor_daemon_ready=1
    doctor_ok "Docker daemon" "reachable"
  else
    doctor_fail "Docker daemon" "not reachable"
    echo "      Next: start Docker Desktop (or the docker service), then retry"
  fi
else
  doctor_skip "Docker Compose v2" "not checked because the Docker CLI is missing"
  doctor_skip "Docker daemon" "not checked because the Docker CLI is missing"
fi

if [ "$doctor_daemon_ready" -eq 1 ]; then
  tenkacloud_docker_daemon_stale
  case "$?" in
    0)
      doctor_fail "Docker containerd version" "daemon is running containerd $TENKACLOUD_RUNNING_CONTAINERD_VERSION, but $TENKACLOUD_ONDISK_CONTAINERD_VERSION is installed on disk"
      echo "      The daemon is running a containerd from before a package upgrade."
      echo "      Its containerd and the freshly upgraded on-disk shim mismatch, so"
      echo "      every container fails at start (\"failed to create shim\")."
      echo "      Next (rootless): systemctl --user restart docker"
      echo "      Next (rootful):  sudo systemctl restart docker"
      ;;
    1)
      doctor_ok "Docker containerd version" "running matches on-disk ($TENKACLOUD_RUNNING_CONTAINERD_VERSION)"
      ;;
    *)
      doctor_skip "Docker containerd version" "running or on-disk containerd version unreadable (e.g. Docker Desktop); skipped"
      ;;
  esac
else
  doctor_skip "Docker containerd version" "not checked because the Docker daemon is unavailable"
fi

if [ "$doctor_daemon_ready" -eq 1 ]; then
  if tenkacloud_resolve_docker_socket; then
    doctor_ok "Docker context" "local Unix socket: $TENKACLOUD_DOCKER_SOCKET"
  else
    case "$TENKACLOUD_DOCKER_SOCKET_ERROR_KIND" in
      remote)
        doctor_fail "Docker context" "remote endpoint $TENKACLOUD_DOCKER_ENDPOINT cannot run local play"
        ;;
      missing)
        doctor_fail "Docker context" "socket $TENKACLOUD_DOCKER_SOCKET does not exist"
        ;;
      *) doctor_fail "Docker context" "could not resolve a usable local Unix socket" ;;
    esac
    tenkacloud_print_docker_socket_guidance "make local"
  fi
else
  doctor_skip "Docker context" "not checked because the Docker daemon is unavailable"
fi

# Docker Desktop exposes host networking only when the user enables it, and
# firewalls can still block loopback even when the setting is on. A report-only
# preflight cannot prove either condition without starting a container. Keep the
# uncertainty visible; `make local` performs the authoritative post-start probe
# against this control plane's /healthz response.
doctor_skip "Portal host reachability" "attempted after startup by make local; reported as unverified when neither curl nor wget is available"

doctor_format_bytes() {
  awk -v bytes="$1" 'BEGIN {
    gib = 1024 * 1024 * 1024
    mib = 1024 * 1024
    if (bytes >= gib) {
      printf "%.2f GiB", bytes / gib
    } else if (bytes >= mib) {
      printf "%d MiB", int(bytes / mib + 0.5)
    } else {
      printf "%d B", bytes
    }
  }'
}

doctor_number_at_least() {
  awk -v actual="$1" -v expected="$2" 'BEGIN { exit !(actual >= expected) }'
}

# Keep this compact table machine-checked against scripts/local/profiles.ts in
# infrastructure/test/scripts/participant-doctor.test.ts. Published numbers
# still cite their measurement record through local-profile-records.test.ts.
doctor_load_profile() {
  doctor_profile_title=""
  doctor_profile_status=""
  doctor_profile_runs=""
  doctor_profile_concurrency=""
  doctor_profile_verified_cpus=""
  doctor_profile_verified_memory=""
  doctor_profile_observed_memory=""
  doctor_profile_platform=""
  doctor_profile_disk_floor=""
  doctor_profile_disk_covers=""
  doctor_profile_unverified=""

  case "$1" in
    minimum)
      doctor_profile_title="Minimum — solve one problem"
      doctor_profile_status="measured"
      doctor_profile_runs="local-play API + Participant Portal; SQLite state store; one lightweight single-container problem"
      doctor_profile_concurrency=1
      doctor_profile_verified_cpus=4
      doctor_profile_verified_memory=4090956349
      doctor_profile_observed_memory=142606336
      doctor_profile_platform="macos-arm64"
      doctor_profile_disk_floor=755000000
      doctor_profile_disk_covers="the tenkacloud-local:dev control-plane image only — problem images and BuildKit cache are additional"
      doctor_profile_unverified="multi-container problems; cold / warm start times; platforms other than macOS arm64"
      ;;
    recommended)
      doctor_profile_title="Recommended — several problems at once"
      doctor_profile_status="partially-measured"
      doctor_profile_runs="local-play API + Participant Portal; SQLite state store; up to 3 problems; terminal, scoring, hints and writeups"
      doctor_profile_concurrency=3
      doctor_profile_disk_floor=755000000
      doctor_profile_disk_covers="the tenkacloud-local:dev control-plane image only — three problem images and BuildKit cache are additional"
      doctor_profile_unverified="3 concurrent problems; multi-container problems; 30-60 minutes of continuous use; repeated resource reclaim; platforms other than macOS arm64"
      ;;
    full)
      doctor_profile_title="Full — a whole event locally"
      doctor_profile_status="planned"
      doctor_profile_runs="recommended profile; experimental Simulator and composite problems; planned event UI and AI agent runner"
      doctor_profile_concurrency=3
      doctor_profile_unverified="every resource figure; which planned components are runnable locally"
      ;;
  esac
}

doctor_profile_worst="pass"
doctor_profile_hard_failures=0

doctor_mark_profile_status() {
  case "$1:$doctor_profile_worst" in
    fail:*)
      doctor_profile_worst="fail"
      doctor_profile_hard_failures=$((doctor_profile_hard_failures + 1))
      ;;
    warn:fail) ;;
    warn:*) doctor_profile_worst="warn" ;;
    unknown:pass) doctor_profile_worst="unknown" ;;
  esac
}

doctor_profile_item() {
  doctor_item_status=$1
  doctor_item_title=$2
  doctor_item_detail=$3
  doctor_item_action=${4:-}
  case "$doctor_item_status" in
    pass) doctor_item_icon="✓" ;;
    warn) doctor_item_icon="!" ;;
    fail) doctor_item_icon="✗" ;;
    *) doctor_item_icon="?" ;;
  esac
  printf '  %s %s — %s\n' "$doctor_item_icon" "$doctor_item_title" "$doctor_item_detail"
  if [ -n "$doctor_item_action" ]; then
    printf '      Next: %s\n' "$doctor_item_action"
  fi
  doctor_mark_profile_status "$doctor_item_status"
}

doctor_report_profile() {
  doctor_load_profile "$doctor_profile"
  doctor_profile_worst="pass"

  doctor_tab=$(printf '\t')
  doctor_info_format="{{.NCPU}}${doctor_tab}{{.MemTotal}}${doctor_tab}{{.ServerVersion}}${doctor_tab}{{.OperatingSystem}}${doctor_tab}{{.Architecture}}"
  doctor_info=""
  if [ "$doctor_daemon_ready" -eq 1 ]; then
    doctor_info=$(docker info --format "$doctor_info_format" 2>/dev/null || true)
  fi
  doctor_cpus=$(printf '%s\n' "$doctor_info" | awk -F '\t' 'NR == 1 && $1 ~ /^[0-9]+$/ && $1 > 0 { print $1 }')
  doctor_memory=$(printf '%s\n' "$doctor_info" | awk -F '\t' 'NR == 1 && $2 ~ /^[0-9]+$/ && $2 > 0 { print $2 }')
  doctor_free_disk=""
  if [ "$doctor_probe_disk" -eq 1 ] && [ "$doctor_daemon_ready" -eq 1 ]; then
    if tenkacloud_probe_docker_disk; then
      doctor_free_disk=$TENKACLOUD_DOCKER_DISK_AVAILABLE_BYTES
    fi
  fi

  echo ""
  printf 'Selected profile: %s — %s (%s)\n' "$doctor_profile" "$doctor_profile_title" "$doctor_profile_status"
  printf '  Runs: %s\n' "$doctor_profile_runs"
  printf '  Concurrent problems: %s\n' "$doctor_profile_concurrency"

  if [ -z "$doctor_cpus" ]; then
    doctor_profile_item "unknown" "Docker CPUs" "could not read the CPU count Docker has" \
      "Start the Docker daemon, then re-run make doctor PROFILE=$doctor_profile"
  elif [ -z "$doctor_profile_verified_cpus" ]; then
    doctor_profile_item "unknown" "Docker CPUs" "$doctor_cpus available; no measurement recorded for the \"$doctor_profile\" profile yet" \
      "Read docs/local-play-requirements.md#not-measured-yet; no pass/fail threshold is published for this profile"
  elif [ "$doctor_cpus" -ge "$doctor_profile_verified_cpus" ]; then
    doctor_profile_item "pass" "Docker CPUs" "$doctor_cpus available; measured working with $doctor_profile_verified_cpus ($doctor_profile_platform)"
  else
    doctor_profile_item "warn" "Docker CPUs" "$doctor_cpus available; measured working with $doctor_profile_verified_cpus ($doctor_profile_platform) — fewer CPUs than any measured run, so this size is untested rather than known to fail" \
      "Raise the Docker CPU allocation in Docker Desktop or Colima"
  fi

  if [ -z "$doctor_memory" ]; then
    doctor_profile_item "unknown" "Docker memory" "could not read the memory Docker has" \
      "Start the Docker daemon, then re-run make doctor PROFILE=$doctor_profile"
  elif [ -z "$doctor_profile_verified_memory" ]; then
    doctor_profile_item "unknown" "Docker memory" "$(doctor_format_bytes "$doctor_memory") available; no measurement recorded for the \"$doctor_profile\" profile yet" \
      "Read docs/local-play-requirements.md#not-measured-yet; no pass/fail threshold is published for this profile"
  else
    doctor_memory_detail="$(doctor_format_bytes "$doctor_memory") available; measured working with $(doctor_format_bytes "$doctor_profile_verified_memory") while the containers themselves used $(doctor_format_bytes "$doctor_profile_observed_memory") ($doctor_profile_platform)"
    if doctor_number_at_least "$doctor_memory" "$doctor_profile_verified_memory"; then
      doctor_profile_item "pass" "Docker memory" "$doctor_memory_detail"
    else
      doctor_profile_item "warn" "Docker memory" "$doctor_memory_detail — less memory than any measured run, so this size is untested rather than known to fail" \
        "Raise the Docker memory allocation in Docker Desktop or Colima"
    fi
  fi

  if [ -z "$doctor_free_disk" ]; then
    doctor_profile_item "unknown" "Docker VM free disk" "could not read free space on the Docker VM disk" \
      "Re-run with PROBE_DISK=1 (pulls busybox), or run: docker run --rm busybox df -P /"
  elif [ -z "$doctor_profile_disk_floor" ]; then
    doctor_profile_item "unknown" "Docker VM free disk" "$(doctor_format_bytes "$doctor_free_disk") free; no image footprint recorded for the \"$doctor_profile\" profile yet" \
      "Read docs/local-play-requirements.md#not-measured-yet; no pass/fail threshold is published for this profile"
  else
    doctor_disk_detail="$(doctor_format_bytes "$doctor_free_disk") free; $(doctor_format_bytes "$doctor_profile_disk_floor") is $doctor_profile_disk_covers"
    if doctor_number_at_least "$doctor_free_disk" "$doctor_profile_disk_floor"; then
      doctor_profile_item "pass" "Docker VM free disk" "$doctor_disk_detail"
    else
      doctor_profile_item "fail" "Docker VM free disk" "$doctor_disk_detail — below the floor, so the image cannot finish materialising" \
        "Free Docker VM space: docker builder prune -af && docker image prune -af"
    fi
  fi

  case "$doctor_profile_worst" in
    pass) doctor_summary="PASS — this machine is at or above every configuration this profile was measured in." ;;
    warn) doctor_summary="WARN — this machine is below every measured configuration. Untested, not known to fail." ;;
    fail) doctor_summary="FAIL — Docker VM free disk is below a measured hard floor." ;;
    *) doctor_summary="UNKNOWN — at least one value could not be read or has never been measured." ;;
  esac
  printf '  Result: %s\n' "$doctor_summary"
  printf '  Not measured yet: %s\n' "$doctor_profile_unverified"
  if [ "$doctor_probe_disk" -ne 1 ]; then
    echo "  (PROBE_DISK=1 also measures Docker VM free space; it pulls busybox.)"
  fi
  echo "  Profile definitions: docs/local-play-requirements.md"
}

if [ -n "$doctor_profile" ]; then
  doctor_report_profile
fi

if [ "$doctor_failures" -eq 0 ] && [ "$doctor_profile_hard_failures" -eq 0 ]; then
  echo ""
  echo "All pre-start participant prerequisites are satisfied."
  echo "Run \`make local\`; it will attempt Portal host reachability after startup and report if that check is unavailable."
  exit 0
fi

echo ""
if [ "$doctor_failures" -gt 0 ]; then
  echo "$doctor_failures participant prerequisite check(s) need action before \`make local\`." >&2
fi
if [ "$doctor_profile_hard_failures" -gt 0 ]; then
  echo "$doctor_profile_hard_failures measured hard requirement(s) need action before \`make local\`." >&2
fi
exit 1
