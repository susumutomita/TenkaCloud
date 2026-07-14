#!/usr/bin/env sh
# Codespaces auto-start (.devcontainer/devcontainer.json postStartCommand).
#
# codespaces-onboarding.test.ts pins the promise: "A fresh Codespace must reach a
# working `make local` with zero manual steps." postCreate only INSTALLS; nothing
# ever STARTED local play, so a learner who has never used a terminal opened the
# Codespace to an idle prompt and an empty port-5175 preview. This script starts
# local play automatically on every container start.
#
# `make local` is idempotent (it no-ops when local play is already running) and
# problems start on demand from the browser portal, so re-running on each start is
# safe.
set -eu

repo_root=$(cd "$(dirname "$0")/../.." && pwd)

# A bun that codespaces-setup.sh installed lives in ~/.bun/bin, which this fresh
# lifecycle shell's PATH predates — prefix it so `make local` finds bun (same
# ordering rule pinned for codespaces-setup.sh / onboard-bootstrap.sh).
export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
export PATH="$BUN_INSTALL/bin:$PATH"

log="${HOME}/tenkacloud-local-play.log"

# Detach so the (long-running) vite portal keeps serving past this shell.
nohup make -C "$repo_root" local >"$log" 2>&1 &
start_pid=$!

# Backgrounding alone reports success even when `make local` dies (a missing dep,
# a vite crash, a port clash) — which would drop the learner right back on an empty
# port-5175 preview. Wait for the portal to actually answer, and FAIL LOUD (exit
# non-zero) if the start process exits first, so a broken start is surfaced in the
# Codespaces startup UI instead of silently passing.
portal_url="http://127.0.0.1:5175"
attempt=0
while [ "$attempt" -lt 60 ]; do
  if ! kill -0 "$start_pid" 2>/dev/null; then
    echo "ERROR: local play exited during startup — the Participant Portal will not open." >&2
    echo "Last 40 log lines ($log):" >&2
    tail -n 40 "$log" 2>/dev/null || true
    exit 1
  fi
  if curl -sf -o /dev/null "$portal_url" 2>/dev/null; then
    echo "TenkaCloud local play is up — the Participant Portal opens on port 5175 (no command needed)."
    echo "Startup log: $log"
    exit 0
  fi
  attempt=$((attempt + 1))
  sleep 2
done

# Still alive after the wait (e.g. a cold dependency install) — leave it running and
# tell the learner it is on its way rather than hard-failing a healthy-but-slow start.
echo "TenkaCloud local play is still starting (taking longer than usual)."
echo "The Participant Portal on port 5175 will open when it is ready. Startup log: $log"
