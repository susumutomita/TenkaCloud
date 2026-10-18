#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
bun_version="$(awk -F '"' '/^bun = "[0-9]+\.[0-9]+\.[0-9]+"$/ { print $2 }' mise.toml)"
if [[ ! "$bun_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo 'Expected one exact Bun version in mise.toml.' >&2
  exit 1
fi

export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
export PATH="$BUN_INSTALL/bin:$PATH"
if [[ ! -x "$BUN_INSTALL/bin/bun" ]] || [[ "$("$BUN_INSTALL/bin/bun" --version)" != "$bun_version" ]]; then
  command -v unzip >/dev/null || { echo 'Bun installation requires unzip.' >&2; exit 1; }
  curl --fail --silent --show-error --location https://bun.com/install | bash -s -- "bun-v$bun_version"
fi
if [[ "$(bun --version)" != "$bun_version" ]]; then
  echo "Bun installation did not provide the pinned version $bun_version." >&2
  exit 1
fi

make install
