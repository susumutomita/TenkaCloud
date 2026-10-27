export const CARD_GAP = 16;
export function cardHeightBudget(width) {
  // Numeric keyboard cues add a wrapped line on the narrowest supported phones.
  return width <= 350 ? 148 : 132;
}
export function fieldCapacity(height, columns, width = 375) {
  const perLane = Math.floor(
    Math.max(0, height - 16 + CARD_GAP) / (cardHeightBudget(width) + CARD_GAP),
  );
  return Math.max(1, Math.min(6, perLane * columns));
}
