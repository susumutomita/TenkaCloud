// Foreground, presented-play time only. A suspended/delayed frame never consumes a deadline.
export const ROUND_WINDOW_MS = 60_000;
export function createClock(now = 0) {
  return { elapsed: 0, last: Number.isFinite(now) ? now : 0 };
}
export function advanceClock(clock, now, running) {
  if (!Number.isFinite(now)) return clock;
  const delta = now - clock.last;
  const visibleDelta = running && delta >= 0 && delta <= 1000 ? delta : 0;
  return {
    elapsed: Math.min(ROUND_WINDOW_MS, clock.elapsed + visibleDelta),
    last: Math.max(clock.last, now),
  };
}
export function progress(clock) {
  return Math.max(0, Math.min(1, clock.elapsed / ROUND_WINDOW_MS));
}
