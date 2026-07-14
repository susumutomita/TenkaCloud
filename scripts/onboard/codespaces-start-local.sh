#!/usr/bin/env sh
# Codespaces auto-start (.devcontainer/devcontainer.json postStartCommand).
#
# codespaces-onboarding.test.ts pins the promise: "A fresh Codespace must reach a
# working `make local` with zero manual steps." postCreate only INSTALLS; nothing
# ever STARTED local play, so a learner who has never used a terminal opened the
# Codespace to an idle prompt and an empty port-5175 preview. This script closes
# that gap by starting local play automatically on every container start.
#
# `make local` is idempotent (it no-ops when local play is already running) and
# problems start on demand from the browser portal, so re-running on each start is
# safe. Detach with `nohup ... &` so this lifecycle step returns immediately; the
# Participant Portal on port 5175 (onAutoForward=openPreview) then forwards and
# opens on its own — no command typed by the learner.
set -eu

repo_root=$(cd "$(dirname "$0")/../.." && pwd)

# A bun that codespaces-setup.sh installed lives in ~/.bun/bin, which this fresh
# lifecycle shell's PATH predates — prefix it so `make local` finds bun (same
# ordering rule pinned for codespaces-setup.sh / onboard-bootstrap.sh).
export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
export PATH="$BUN_INSTALL/bin:$PATH"

log="${HOME}/tenkacloud-local-play.log"
nohup make -C "$repo_root" local >"$log" 2>&1 &

echo "TenkaCloud local play is starting in the background — no command needed."
echo "The Participant Portal opens automatically on port 5175 (see the Ports tab)."
echo "Startup logs: $log"
