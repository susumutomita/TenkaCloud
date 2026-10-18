/** Paired Orders. Openings stay with the judge until BOTH have been accepted. */
import { isCommitment, isHand, isRandomness, rpsOutcome, verifyOpening } from "./commitment.ts";
import { settleRpsHunts } from "./rps-hunt.ts";
import { compactContractId, encodeArtifact } from "./ledger-codec.ts";
import type { Contract, CryptoBattleOp, CryptoBattleState, DuelOutcome, OrderTaskProjection, RpsOpenArtifact, ValidateResult } from "./types.ts";

/** Circle schedule: every pair meets; an odd roster rotates the bye. */
export function pairTeams(teamIds: readonly string[], round: number): readonly (readonly [string, string])[] {
  const ring: (string | undefined)[] = [...teamIds].sort();
  if (ring.length < 2) return [];
  if (ring.length % 2) ring.push(undefined);
  for (let i = 0; i < round % (ring.length - 1); i++) ring.splice(1, 0, ring.pop());
  const pairs: [string, string][] = [];
  for (let i = 0; i < ring.length / 2; i++) {
    const first = ring[i], second = ring[ring.length - 1 - i];
    if (first !== undefined && second !== undefined) pairs.push([first, second]);
  }
  return pairs;
}

export function opponentOrder(state: CryptoBattleState, order: Contract): Contract | undefined {
  const task = order.task;
  if (task.kind !== "rps-duel") return undefined;
  return state.contracts.find(c => c.teamId === task.opponentTeamId && c.task.kind === "rps-duel" && c.task.duelId === task.duelId);
}

type DuelOp = Extract<CryptoBattleOp, { kind: "rps-commit" | "rps-open" }>;
export function validateRps(state: CryptoBattleState, teamId: string, op: DuelOp): ValidateResult {
  const order = state.contracts.find(c => c.id === op.contractId);
  if (!order || order.teamId !== teamId || order.task.kind !== "rps-duel" || order.status !== "open") return { ok: false, error: "Choose your open rock-paper-scissors Order." };
  const opponent = opponentOrder(state, order);
  if (!opponent || opponent.status !== "open" || (state.nowMs ?? 0) >= order.expiresAtMs) return { ok: false, error: "This duel has ended." };
  if (op.kind === "rps-commit") {
    if (order.rps?.commitment !== undefined) return { ok: false, error: "Your sealed number was already submitted; it cannot be replaced." };
    return isCommitment(op.commitment) ? { ok: true } : { ok: false, error: "The sealed number must be a power of 4 after division by 23 (1–22). Check your calculation." };
  }
  // The trusted judge can hold an opening before the opponent commits.
  // It is published only by the atomic two-opening settlement below.
  if (order.rps?.commitment === undefined) return { ok: false, error: "Submit your sealed number before giving the judge your opening." };
  if (order.rps.opening) return { ok: false, error: "Your opening was already accepted; it cannot be replaced." };
  return isHand(op.hand) && isRandomness(op.randomness) && verifyOpening(order.rps.commitment, op.hand, op.randomness)
    ? { ok: true } : { ok: false, error: "The hand and hiding number do not reproduce your sealed number. Check your notes; no points were deducted." };
}

export function applyRps(state: CryptoBattleState, teamId: string, op: DuelOp): CryptoBattleState {
  const validation = validateRps(state, teamId, op);
  if (!validation.ok) throw new Error(validation.error);
  const order = state.contracts.find(c => c.id === op.contractId)!;
  if (order.task.kind !== "rps-duel") throw new Error("applyRps: expected a duel");
  if (op.kind === "rps-commit") return {
    ...state,
    contracts: state.contracts.map(c => c.id === order.id ? { ...c, rps: { commitment: op.commitment } } : c),
    publicLedger: [...state.publicLedger, encodeArtifact({
      id: `${order.id}-rps-commit`, kind: "rps-commit", method: "duel", teamId,
      generation: state.teams[teamId]!.generation, contractId: order.id, duelId: order.task.duelId,
      postedAtMs: state.nowMs!, commitment: op.commitment,
    }, state.teams)],
  };
  if (!isHand(op.hand)) throw new Error("applyRps: invalid hand");
  const opened: Contract = { ...order, rps: { ...order.rps, opening: { hand: op.hand, randomness: op.randomness } } };
  const next = { ...state, contracts: state.contracts.map(c => c.id === order.id ? opened : c) };
  const opponent = opponentOrder(next, opened)!;
  if (!opponent.rps?.opening) return next;
  const result = rpsOutcome(op.hand, opponent.rps.opening.hand);
  const outcomes = new Map<string, DuelOutcome>([
    [opened.id, result === "draw" ? "draw" : result === "first" ? "win" : "loss"],
    [opponent.id, result === "draw" ? "draw" : result === "second" ? "win" : "loss"],
  ]);
  const teams = { ...next.teams };
  const artifacts: RpsOpenArtifact[] = [];
  for (const c of [opened, opponent]) {
    const team = teams[c.teamId]!;
    const outcome = outcomes.get(c.id)!;
    teams[c.teamId] = { ...team, score: team.score + (outcome === "win" ? state.config.scores.duelWin : outcome === "draw" ? state.config.scores.duelDraw : 0), completedContractIds: [...team.completedContractIds, compactContractId(c.teamId, c.id)] };
    artifacts.push({
      id: `${c.id}-rps-open`, kind: "rps-open", method: "duel", teamId: c.teamId,
      generation: team.generation, contractId: c.id, duelId: order.task.duelId, postedAtMs: state.nowMs!,
      commitment: c.rps!.commitment!, ...c.rps!.opening!,
    });
  }
  return settleRpsHunts({
    ...next, teams,
    contracts: next.contracts.map(c => outcomes.has(c.id) ? { ...c, status: "completed", resolution: "duel", rps: { ...c.rps, outcome: outcomes.get(c.id)! } } : c),
    publicLedger: [...state.publicLedger, ...artifacts.map(a => encodeArtifact(a, state.teams))],
  }, [opened.id, opponent.id], state.nowMs!, false);
}

/** A ready player cannot be held hostage by an absent opponent. No opening is published on a timeout. */
export function expireRps(state: CryptoBattleState, atMs: number): CryptoBattleState {
  const teams = { ...state.teams };
  const contracts = state.contracts.map((c): Contract => {
    if (c.task.kind !== "rps-duel" || c.status !== "open" || c.expiresAtMs > atMs) return c;
    const opponent = opponentOrder(state, c);
    const ready = c.rps?.opening !== undefined || (c.rps?.commitment !== undefined && opponent?.rps?.commitment === undefined);
    const team = teams[c.teamId]!;
    teams[c.teamId] = { ...team, score: Math.max(0, team.score + (ready ? state.config.scores.duelWin : state.config.scores.expiredOrder)), completedContractIds: ready ? [...team.completedContractIds, compactContractId(c.teamId, c.id)] : team.completedContractIds };
    return ready ? { ...c, status: "completed", resolution: "duel", rps: { ...c.rps, outcome: "forfeit-win" } }
      : { ...c, status: "expired", expiryCause: "deadline" };
  });
  return settleRpsHunts({ ...state, teams, contracts }, state.contracts.filter(c => c.task.kind === "rps-duel" && c.status === "open" && c.expiresAtMs <= atMs).map(c => c.id), atMs, true);
}

export function projectRps(state: CryptoBattleState, order: Contract): Extract<OrderTaskProjection, { kind: "rps-duel" }> {
  if (order.task.kind !== "rps-duel") throw new Error("projectRps: expected a duel");
  const opponent = opponentOrder(state, order);
  return {
    ...order.task, drawPoints: state.config.scores.duelDraw, expiryPenalty: state.config.scores.expiredOrder,
    ...(order.rps?.commitment === undefined ? {} : { myCommitment: order.rps.commitment }),
    ...(opponent?.rps?.commitment === undefined ? {} : { opponentCommitment: opponent.rps.commitment }),
    ...(order.rps?.opening === undefined ? {} : { myOpening: order.rps.opening }),
    opponentCommitted: opponent?.rps?.commitment !== undefined,
    opponentOpened: opponent?.rps?.opening !== undefined,
    ...(order.rps?.outcome === undefined ? {} : { outcome: order.rps.outcome }),
  };
}
