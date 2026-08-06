#!/usr/bin/env sh
# [Issue #2119] Pre-bun bootstrap for `make local-onboard`.
#
# This handles ONLY what cannot be a bun script: trusting mise (which gates the
# pinned tools, including bun) and making bun itself available. Once bun is
# present it hands control back to the Makefile, which runs the real onboarder
# (scripts/tenkacloud-onboard.ts — submodule + Docker diagnosis, with consent).
#
# UX rules (matching the bun onboarder): never install software without consent;
# in a non-interactive run, require `--yes`; if the user declines, print the
# manual command and exit non-zero so the caller stops cleanly.
set -eu

AUTO_YES=0
for arg in "$@"; do
  case "$arg" in
    --yes | -y) AUTO_YES=1 ;;
  esac
done

interactive() { [ -t 0 ] && [ -z "${CI:-}" ]; }

# consent "<question>" → 0 if the user agrees (via --yes or an interactive y/N).
consent() {
  if [ "$AUTO_YES" -eq 1 ]; then return 0; fi
  if ! interactive; then return 1; fi
  printf '%s [y/N] ' "$1"
  read -r reply
  case "$reply" in
    y | Y | yes | YES) return 0 ;;
    *) return 1 ;;
  esac
}

repo_root=$(cd "$(dirname "$0")/../.." && pwd)

# 1) mise trust — only when mise.toml exists, mise is installed, and it is untrusted.
if [ -f "$repo_root/mise.toml" ] && command -v mise >/dev/null 2>&1; then
  if mise ls 2>&1 | grep -qi "not trusted"; then
    echo "mise.toml is present but not trusted — mise will not activate the pinned tools."
    if consent "Trust this repo's mise.toml? (runs: mise trust)"; then
      mise trust
    else
      echo "  Manual: mise trust"
    fi
  fi
fi

# 2) bun — the gateway to every other script. If absent, offer a consented install.
if ! command -v bun >/dev/null 2>&1; then
  bun_installer="$repo_root/scripts/onboard/install-bun.sh"
  bun_cmd="bash scripts/onboard/install-bun.sh"
  echo "Bun is required (it runs every TenkaCloud script and installs dependencies)."
  echo "  Install command: $bun_cmd"
  if consent "Install Bun now?"; then
    bash "$bun_installer"
    # The installer drops bun into ~/.bun/bin and edits the shell profile, but
    # THIS shell's PATH is unchanged — without this export the re-check below
    # fails right after a successful install (seen in Codespaces postCreate,
    # where that false failure aborted the whole setup chain).
    export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
    export PATH="$BUN_INSTALL/bin:$PATH"
  fi
  if ! command -v bun >/dev/null 2>&1; then
    echo ""
    echo "Bun is still not on PATH. Install it, then re-run \`make local-onboard\`:"
    echo "  bash scripts/onboard/install-bun.sh"
    echo "  (if bun is managed by mise: mise trust && mise install)"
    exit 1
  fi
fi

exit 0
