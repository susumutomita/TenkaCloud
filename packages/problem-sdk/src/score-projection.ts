/** A policy copied into an event definition. Catalog edits do not change old events. */
export interface PinnedScorePolicy {
  readonly problemId: string;
  readonly scoreFloor?: number;
}

/** Raw signed entries remain the audit ledger, including hints and gate bonuses. */
export interface ScoreLedgerEntry {
  readonly problemId: string;
  readonly points: number;
}

export interface ScoreProjection {
  readonly total: number;
  readonly byProblem: Readonly<Record<string, number>>;
}

function policiesById(policies: readonly PinnedScorePolicy[]): Map<string, number | undefined> {
  const result = new Map<string, number | undefined>();
  for (const policy of policies) {
    if (!policy.problemId || result.has(policy.problemId))
      throw new Error("Score projection requires unique pinned problem IDs.");
    if (policy.scoreFloor !== undefined && !Number.isFinite(policy.scoreFloor))
      throw new Error(`Invalid score floor for ${policy.problemId}.`);
    result.set(policy.problemId, policy.scoreFloor);
  }
  return result;
}

/** Incremental projection; timeline callers pass entries in timestamp order. */
export function projectScoreTimeline(
  policies: readonly PinnedScorePolicy[],
  entries: readonly ScoreLedgerEntry[],
): readonly number[] {
  const floors = policiesById(policies);
  const raw = new Map<string, number>();
  let total = [...floors.values()].reduce<number>(
    (sum, floor) => sum + (floor === undefined ? 0 : Math.max(floor, 0)),
    0,
  );
  const totals: number[] = [];
  for (const entry of entries) {
    if (!floors.has(entry.problemId))
      throw new Error(`Score entry names an unpinned problem: ${entry.problemId}.`);
    if (!Number.isFinite(entry.points)) throw new Error("Score entry points must be finite.");
    const prior = raw.get(entry.problemId) ?? 0;
    const next = prior + entry.points;
    const floor = floors.get(entry.problemId);
    total +=
      (floor === undefined ? next : Math.max(floor, next)) -
      (floor === undefined ? prior : Math.max(floor, prior));
    raw.set(entry.problemId, next);
    totals.push(total);
  }
  return totals;
}

/** Project each problem independently, then sum; never floor the whole event. */
export function projectScore(
  policies: readonly PinnedScorePolicy[],
  entries: readonly ScoreLedgerEntry[],
): ScoreProjection {
  const floors = policiesById(policies);
  const raw = new Map<string, number>();
  for (const entry of entries) {
    if (!floors.has(entry.problemId))
      throw new Error(`Score entry names an unpinned problem: ${entry.problemId}.`);
    if (!Number.isFinite(entry.points)) throw new Error("Score entry points must be finite.");
    raw.set(entry.problemId, (raw.get(entry.problemId) ?? 0) + entry.points);
  }
  const byProblem: Record<string, number> = {};
  let total = 0;
  for (const [problemId, floor] of floors) {
    const points = raw.get(problemId) ?? 0;
    const score = floor === undefined ? points : Math.max(floor, points);
    byProblem[problemId] = score;
    total += score;
  }
  return { total, byProblem };
}
