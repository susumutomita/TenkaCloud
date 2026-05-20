export function sumHintPenalties(hints: readonly unknown[], hintsRevealed: number): number {
  let penaltyTotal = 0;
  for (let i = 0; i < Math.min(hintsRevealed, hints.length); i += 1) {
    const h = hints[i] as Record<string, unknown> | string;
    const p = typeof h === "object" && h !== null ? Number(h.penalty ?? 0) : 0;
    penaltyTotal += p;
  }
  return penaltyTotal;
}
