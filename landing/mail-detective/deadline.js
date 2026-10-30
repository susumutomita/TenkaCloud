// Foreground, presented-play time only. A suspended/delayed frame never consumes a deadline.
export const ROUND_WINDOW_MS = 30_000;
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

// A selected answer is feedback, not an explicit inspection pause.
export function inspectionOpen(view, compact, explanationOpen = false) {
  return (
    (compact && view.active === "reference") ||
    Object.values(view.address).some(Boolean) ||
    Object.values(view.link).some(Boolean) ||
    Object.values(view.original).some(Boolean) ||
    explanationOpen
  );
}
export function viewAfterAnswer(view, target) {
  return {
    ...view,
    active: "received",
    lastTarget: target,
    idnOpen: {},
    address: { reference: false, received: false },
    link: { reference: false, received: false },
    original: { reference: false, received: false },
  };
}
