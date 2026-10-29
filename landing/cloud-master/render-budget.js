// Bounded, local-only active RAF evidence; this is not a hardware benchmark.
export const RENDER_SAMPLES = 120;
export const RENDER_MIN_SAMPLES = 60;
export const SLOW_FRAME_STREAK = 8;
export function percentile(values, fraction) {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)] ?? null;
}
export function createRenderBudget() {
  return {
    enabled: false,
    samples: [],
    outliers: [],
    ignoredFrames: 0,
    ignoredMs: 0,
    excludedClockMs: 0,
    presentationExtensions: 0,
    context: {},
  };
}
export function outlierThreshold(budget) {
  return budget.samples.length >= 15 ? Math.max(50, percentile(budget.samples, 0.5) * 4) : 1000;
}
export function ignoreFrame(budget, milliseconds) {
  budget.ignoredFrames++;
  budget.ignoredMs += milliseconds;
}
export function observeFrame(budget, milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return { advance: 0 };
  if (milliseconds > outlierThreshold(budget)) {
    ignoreFrame(budget, milliseconds);
    budget.outliers.push(milliseconds);
    if (budget.outliers.length < SLOW_FRAME_STREAK) return { advance: 0 };
    const evidence = [...budget.outliers];
    budget.samples = [...evidence];
    budget.outliers = [];
    return { advance: 0, sustainedFrameMs: percentile(evidence, 0.5), evidence };
  }
  budget.outliers = [];
  budget.samples.push(milliseconds);
  if (budget.samples.length > RENDER_SAMPLES) budget.samples.shift();
  return { advance: milliseconds };
}
export function renderEvidence(budget) {
  return {
    method: "active-raf-p90-120-v1",
    samples: budget.samples.length,
    frameP90Ms: percentile(budget.samples, 0.9),
    frameMedianMs: percentile(budget.samples, 0.5),
    minimumSamples: RENDER_MIN_SAMPLES,
    requiredFrames: 3,
    outlierRule:
      "gap > max(50ms,4*median);1000ms before15samples;8 consecutive outliers confirm a slow rate",
    ignoredFrames: budget.ignoredFrames,
    ignoredMs: budget.ignoredMs,
    excludedClockMs: budget.excludedClockMs,
    presentationExtensions: budget.presentationExtensions,
    context: { ...budget.context },
  };
}
