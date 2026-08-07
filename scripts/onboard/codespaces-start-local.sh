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

log="${HOME}/tenkacloud-local-play.log"

# Detach so the (long-running) control-plane container keeps serving past this shell.
# [#2906 round 2] `make local` is the Docker-only launcher (scripts/local/docker-
# launcher.sh) now, not a bare `bun` process — no PATH/bun setup needed here.
nohup make -C "$repo_root" local >"$log" 2>&1 &
start_pid=$!

# Backgrounding alone reports success even when `make local` dies (a missing dep,
# a vite crash, a port clash) — which would drop the learner right back on an empty
# port-5175 preview. Wait for the portal to actually answer, and FAIL LOUD (exit
# non-zero) if the start process exits first, so a broken start is surfaced in the
# Codespaces startup UI instead of silently passing.
portal_url="http://127.0.0.1:5175"
# Bound the whole probe by wall clock, and bound each curl with --max-time: a server
# that accepts the connection but never sends a response would make a bare curl block
# forever, so the loop would never reach its timeout. `date +%s` keeps the total
# bounded regardless of how long any single probe takes.
# [#2906 round 2] `make local` now runs `docker compose build && docker compose up -d`
# (docker-launcher.sh), not a warm `vite dev` restart — codespaces-setup.sh's postCreate
# pre-builds the image so this build is normally a fast cache hit, but a cold/evicted
# cache, plus `up -d` and the container healthcheck's own start_period + retries
# (compose.local.yaml), can still take noticeably longer than the old two-second vite
# start this deadline was originally sized for. 240s keeps a real margin over that
# worst case while still failing loud well within a learner's patience.
deadline=$(( $(date +%s) + 240 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  if ! kill -0 "$start_pid" 2>/dev/null; then
    echo "ERROR: local play exited during startup — the Participant Portal will not open." >&2
    echo "Last 40 log lines ($log):" >&2
    tail -n 40 "$log" 2>/dev/null || true
    exit 1
  fi
  # Confirm the response is actually OUR portal (its <title>), not merely that
  # SOMETHING answered on 5175 — a stale/foreign server, or a PID-reuse race on
  # start_pid, could otherwise let readiness falsely succeed on the wrong process.
  if curl -sf --max-time 5 "$portal_url" 2>/dev/null | grep -q "TenkaCloud Participant Portal"; then
    echo "TenkaCloud local play is up — the Participant Portal is serving on port 5175 (no command needed)."
    echo "Startup log: $log"
    exit 0
  fi
  sleep 2
done

# Portal never answered within the (generous, build-cost-inclusive) window. postCreate
# already pre-built the image, so this is normally still fast — reaching here means the
# build cache did not stick, the daemon is unusually slow, or the start is genuinely
# wedged/broken. The background process is LEFT RUNNING (it may still come up and
# forward 5175), but the timeout is surfaced as a failure (exit non-zero) rather than a
# green "success" hiding an empty preview.
echo "ERROR: the Participant Portal did not answer on 5175 within the startup window." >&2
echo "Local play is still running in the background and may yet come up; if not, check the log." >&2
echo "Last 40 log lines ($log):" >&2
tail -n 40 "$log" 2>/dev/null || true
exit 1
