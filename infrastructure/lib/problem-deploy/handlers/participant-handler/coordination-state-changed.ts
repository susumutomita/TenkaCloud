export function coordinationStateChanged(prev: unknown, next: unknown): boolean {
  if (prev === next) return false;
  return JSON.stringify(prev) !== JSON.stringify(next);
}
