#!/usr/bin/env bash
# One reviewed Bun installer source for onboarding and CodeBuild setup.
set -euo pipefail

BUN_INSTALL_URL="https://bun.com/install"

if [[ -n "${1:-}" ]]; then
  curl -fsSL "$BUN_INSTALL_URL" | bash -s "bun-v$1"
else
  curl -fsSL "$BUN_INSTALL_URL" | bash
fi
