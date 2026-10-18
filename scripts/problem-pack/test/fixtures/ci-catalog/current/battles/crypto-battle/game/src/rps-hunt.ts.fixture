import { artifactFields } from "./ledger-codec.ts";
import { huntCount, changeHuntCount } from "./hunt-budget.ts";
/** Predictions use public repeated-r records and settle only after simultaneous publication. */
import { isHand } from "./commitment.ts";
import { huntKey, storedHuntKey, pruneRetiredHuntAttempts, predictionKey, predictionTeam } from "./hunt-key.ts";
import { storedTeamId, decodeArtifact } from "./ledger-codec.ts";
import type { Contract, CryptoBattleOp, CryptoBattleState, RpsHuntProjection, RpsHuntResult, RpsOpenArtifact, ValidateResult } from "./types.ts";

type HuntOp = Extract<CryptoBattleOp, { kind: "hunt-rps" }>;

/** Two different completed duels, not two copies of the same public opening. */
export function rpsReuseEvidence(state: CryptoBattleState, teamId: string): readonly RpsOpenArtifact[] {
  const seen = new Map<number, RpsOpenArtifact>();
  for (let i = state.publicLedger.length - 1; i >= 0; i--) {
    const a = artifactFields(state.publicLedger[i]!);
    if (a.k !== "rps-open" || storedTeamId(a, state.teams) !== teamId) continue;
    const previous = seen.get(a.r);
    const record = decodeArtifact(a, state.teams) as RpsOpenArtifact;
    if (previous && previous.duelId !== record.duelId) return [record, previous];
    seen.set(a.r, record);
  }
  return [];
}

function targetOrder(state: CryptoBattleState, target: string, duelId: string): Contract | undefined {
  return state.contracts.find(c => c.teamId === target && c.task.kind === "rps-duel" && c.task.duelId === duelId);
}
function canPredict(state: CryptoBattleState, c: Contract): boolean {
  if (c.task.kind !== "rps-duel") return false;
  const duelId = c.task.duelId;
  return c.status === "open" && c.expiresAtMs > (state.nowMs ?? 0)
    // A hand held privately by the judge has not been published. The final
    // opening completes both Orders in the same state transition as publication.
    && c.rps?.commitment !== undefined
    && state.contracts.some(other => other.task.kind === "rps-duel" && other.task.duelId === duelId && other.teamId !== c.teamId && other.status === "open");
}

export function validateRpsHunt(state: CryptoBattleState, attacker: string, op: HuntOp): ValidateResult {
  if (state.startedAtMs === undefined || state.nowMs === undefined || state.phase === "ended") return { ok: false, error: "RPS prediction requires a running match." };
  if (typeof op.targetTeamId !== "string" || typeof op.duelId !== "string") return { ok: false, error: "Choose another team for the prediction." };
  if (!state.teams[attacker] || !state.teams[op.targetTeamId] || op.targetTeamId === attacker) return { ok: false, error: "Choose another team for the prediction." };
  if (!isHand(op.predictedHand)) return { ok: false, error: "The predicted hand must be 1, 2 or 3." };
  const order = targetOrder(state, op.targetTeamId, op.duelId);
  if (!order || !canPredict(state, order)) return { ok: false, error: "Predict after the target seals a number and before both hands become public." };
  if (order.rps?.predictions?.[predictionKey(state, attacker)]) return { ok: false, error: "Your prediction for this duel was already submitted; it cannot be replaced." };
  if (rpsReuseEvidence(state, op.targetTeamId).length < 2) return { ok: false, error: "Two public openings from different duels must show the same hiding number." };
  const key = storedHuntKey(state, huntKey(attacker, op.targetTeamId, state.teams[op.targetTeamId]!.generation));
  if ((huntCount(state, key) ?? 0) >= state.config.maxHuntAttemptsPerTarget) return { ok: false, error: "No shared HUNT attempts remain for this target generation." };
  return { ok: true };
}

export function applyRpsHunt(state: CryptoBattleState, attacker: string, op: HuntOp): CryptoBattleState {
  const validation = validateRpsHunt(state, attacker, op);
  if (!validation.ok) throw new Error(validation.error);
  if (!isHand(op.predictedHand)) throw new Error("Invalid prediction reached apply");
  const hand = op.predictedHand;
  const order = targetOrder(state, op.targetTeamId, op.duelId)!;
  const generation = state.teams[op.targetTeamId]!.generation;
  const key = storedHuntKey(state, huntKey(attacker, op.targetTeamId, generation));
  return {
    ...state,
    huntAttempts: changeHuntCount(state, key, 1),
    contracts: state.contracts.map(c => c.id === order.id ? { ...c, rps: { ...c.rps, predictions: { ...c.rps?.predictions, [predictionKey(state, attacker)]: [hand, generation] } } } : c),
  };
}

/** Cancel/refund every prediction on a forfeit, even if the judge privately has one hand. */
export function settleRpsHunts(state: CryptoBattleState, ids: readonly string[], atMs: number, cancel: boolean): CryptoBattleState {
  const affected = new Set(ids);
  if (!state.contracts.some(c => affected.has(c.id) && c.rps?.predictions)) return state;
  const teams = { ...state.teams };
  let huntAttempts = state.huntAttempts;
  let retiredReservation = false;
  const contracts = state.contracts.map((c): Contract => {
    if (!affected.has(c.id) || c.task.kind !== "rps-duel" || !c.rps?.predictions) return c;
    if (!cancel && !c.rps.opening) throw new Error("RPS prediction settled without a published opening");
    for (const [attackerKey, [hand, generation]] of Object.entries(c.rps.predictions)) {
      const attacker = predictionTeam(state, attackerKey);
      const team = teams[attacker]!;
      if (generation !== state.teams[c.teamId]!.generation) retiredReservation = true;
      const outcome = cancel ? "cancelled" : hand === c.rps.opening!.hand ? "hit" : "miss";
      const points = outcome === "hit" ? state.config.scores.huntBonus : outcome === "miss" ? -state.config.scores.wrongHunt : 0;
      const score = Math.max(0, team.score + points);
      const lastRpsHunt: RpsHuntResult = {
        targetTeamId: c.teamId, duelId: c.task.duelId, generation, predictedHand: hand,
        ...(cancel ? {} : { actualHand: c.rps.opening!.hand }), outcome, points: score - team.score, atMs,
      };
      teams[attacker] = { ...team, score, lastRpsHunt };
      if (cancel) {
        const key = storedHuntKey(state, huntKey(attacker, c.teamId, generation));
        const count = huntCount({ ...state, huntAttempts }, key);
        if (!count) throw new Error("RPS cancellation has no reserved attempt");
        huntAttempts = changeHuntCount({ ...state, huntAttempts }, key, -1);
      }
    }
    const { predictions, ...rps } = c.rps;
    return { ...c, rps };
  });
  const settled = { ...state, teams, contracts, huntAttempts };
  return retiredReservation ? pruneRetiredHuntAttempts(settled) : settled;
}

export function projectRpsHunt(state: CryptoBattleState, reader: string): RpsHuntProjection {
  const targets: RpsHuntProjection["targets"][number][] = [], pending: RpsHuntProjection["pending"][number][] = [];
  const readerKey = predictionKey(state, reader);
  const evidenceByTeam = new Map<string, readonly RpsOpenArtifact[]>();
  for (const c of state.contracts) {
    if (c.task.kind !== "rps-duel" || c.teamId === reader) continue;
    const prediction = c.rps?.predictions?.[readerKey];
    if (prediction) pending.push({ targetTeamId: c.teamId, duelId: c.task.duelId, predictedHand: prediction[0], generation: prediction[1] });
    if (prediction || !canPredict(state, c) || state.phase === "ended") continue;
    let evidence = evidenceByTeam.get(c.teamId);
    if (!evidence) { evidence = rpsReuseEvidence(state, c.teamId); evidenceByTeam.set(c.teamId, evidence); }
    if (evidence.length < 2) continue;
    targets.push({ targetTeamId: c.teamId, duelId: c.task.duelId, generation: state.teams[c.teamId]!.generation, commitment: c.rps!.commitment!, openingHeld: c.rps?.opening !== undefined, remainingMs: c.expiresAtMs - state.nowMs!, evidence });
  }
  const lastResult = state.teams[reader]!.lastRpsHunt;
  return { targets, pending, winPoints: state.config.scores.huntBonus, ...(lastResult ? { lastResult } : {}) };
}
