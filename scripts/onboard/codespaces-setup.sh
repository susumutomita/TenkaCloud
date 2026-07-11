#!/usr/bin/env sh
# Codespaces postCreate entry point (.devcontainer/devcontainer.json).
#
# One script instead of a `cmd && cmd && cmd` chain, because the bootstrap step
# may install bun into ~/.bun/bin mid-run: a chained `bun run ...` in the SAME
# postCreate shell would not see it (PATH was resolved before the install) and
# the whole chain used to abort — leaving a Codespace with no dependencies and
# no problems/ submodule, where `make local` then failed on both.
set -eu

repo_root=$(cd "$(dirname "$0")/../.." && pwd)

sh "$repo_root/scripts/onboard/onboard-bootstrap.sh" --yes

# Pick up a bun the bootstrap just installed (no-op when bun already existed).
export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
export PATH="$BUN_INSTALL/bin:$PATH"

# Preflight (--yes) checks out the problems/ submodule and diagnoses Docker.
bun run "$repo_root/scripts/tenkacloud-onboard.ts" preflight --yes

# Dependencies for every workspace — `make local` needs vite for the portal.
make -C "$repo_root" install
