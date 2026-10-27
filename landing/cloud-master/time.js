export function formatSurvival(milliseconds) {
  const value = Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : 0;
  return `${(Math.floor(value / 100) / 10).toFixed(1)}秒`;
}
