/** Horizontal intention only; no verdict is inferred from the gesture. */
export function swipeDirection({ dx, dy, elapsed, cancelled = false }) {
  if (
    cancelled ||
    !Number.isFinite(dx) ||
    !Number.isFinite(dy) ||
    Math.abs(dx) < Math.abs(dy) * 1.5
  )
    return null;
  const distance = Math.abs(dx),
    speed = distance / Math.max(1, elapsed);
  if (distance < 48 && !(distance >= 28 && speed >= 0.6 && Math.abs(dy) < 16)) return null;
  return dx < 0 ? "stop" : "allow";
}
