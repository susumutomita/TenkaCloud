export const CARD_GAP = 16;
export function cardHeightBudget(width) {
  // Shared JA/EN bounds keep live cards readable when the language changes.
  const columnWidth = width <= 740 ? width : width / 2;
  if (columnWidth < 375) return 208;
  return columnWidth < 590 ? 172 : 136;
}
export function fieldCapacity(height, columns, width = 375) {
  const perLane = Math.floor(
    Math.max(0, height - 16 + CARD_GAP) / (cardHeightBudget(width) + CARD_GAP),
  );
  return Math.max(1, Math.min(6, perLane * columns));
}
