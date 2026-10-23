import type { Contract, CryptoBattleConfig, CryptoBattleState, MatchDurationRejection } from "./types.ts";

/**
 * [Issue #926] The match length the platform reports (TenkaCloud#3453), and
 * how this Battle follows it.
 *
 * The platform closes the match when its `eventNowMs` clock reaches the
 * reported length, and the local host stops that clock there. So the match
 * ends at that same instant, however late the teams pressed START.
 *
 * Two parts of the length behave differently, which is what keeps the polling
 * cadence immaterial (#897):
 *
 *  - Everything that fires at an instant (phase boundaries, and with them the
 *    booster, Lightning and the phase-dependent Order plan) is fixed once at
 *    START, from the length in force then: thirds of the time left, or the
 *    configured 90 minutes when nothing was reported. Nothing recomputes it.
 *  - The latest accepted report sets only the end and the countdown. `tick`
 *    applies it before replaying the clock, so every event is judged against
 *    the same end however often the host ticks. The end only matters within
 *    one answer window of it, and the platform never moves its end into the
 *    past, so a host that sees a report late replays nothing differently.
 *
 * The local host also reports a shorter length after each scoring-lock pause,
 * so a length that changes after START is routine, not an edge case. For the
 * same reason any length above 0 is accepted: a 5-minute match paused for one
 * minute reports 4 minutes. The organizer's 5-minute floor is the platform's
 * to enforce, on the length chosen at start.
 *
 * `ended` is terminal. By then the end-of-match Order expiries and the
 * Lightning settlement have happened, so no later report reopens the match.
 * This relies on the platform never reporting a stale length: the local host
 * already refuses to move an end that has passed, and the cloud must read the
 * length from the live event at every tick (the TenkaCloud follow-up to #3455).
 */
export const MAX_MATCH_DURATION_MS = 240 * 60_000;

function readMatchDuration(value: unknown):
  | { readonly ok: true; readonly durationMs: number }
  | { readonly ok: false; readonly rejection: MatchDurationRejection } {
  if (typeof value !== "number" || !Number.isFinite(value)) return { ok: false, rejection: "not-a-number" };
  if (value <= 0 || value > MAX_MATCH_DURATION_MS) return { ok: false, rejection: "out-of-range" };
  return { ok: true, durationMs: value };
}

function thirds(lengthMs: number): Pick<CryptoBattleConfig, "matchDurationMs" | "phaseBoundaries"> {
  return { matchDurationMs: lengthMs, phaseBoundaries: { buildToPressureMs: Math.floor(lengthMs / 3), pressureToEndgameMs: Math.floor((2 * lengthMs) / 3) } };
}

/** Open Orders keep the deadline they would have had under the new end. */
function rescheduled(state: CryptoBattleState, config: CryptoBattleConfig): Partial<Pick<CryptoBattleState, "contracts" | "endgameLightning">> {
  const start = state.startedAtMs;
  if (start === undefined) return {};
  const oldEnd = start + state.config.matchDurationMs;
  const newEnd = start + config.matchDurationMs;
  const deadline = (order: Contract) => Math.min(newEnd, order.expiresAtMs === oldEnd
    ? order.issuedAtMs + (order.kind === "rush" ? config.rushContractTtlMs : config.contractTtlMs)
    : order.expiresAtMs);
  const moved = new Map<string, number>();
  const contracts = state.contracts.map((order) => {
    const expiresAtMs = order.status === "open" ? deadline(order) : order.expiresAtMs;
    if (expiresAtMs === order.expiresAtMs) return order;
    moved.set(order.id, expiresAtMs);
    return { ...order, expiresAtMs };
  });
  if (moved.size === 0) return {};
  const lightning = state.endgameLightning;
  if (lightning?.status !== "awarded") return { contracts };
  const cards = Object.fromEntries(Object.entries(lightning.cards).map(([teamId, card]) => {
    const expiresAtMs = card.status === "armed" ? moved.get(card.contractId) : undefined;
    return [teamId, expiresAtMs === undefined ? card : { ...card, expiresAtMs }];
  }));
  return { contracts, endgameLightning: { ...lightning, cards } };
}

/**
 * Applies one platform report. `undefined` is no report and changes nothing,
 * and neither does any report once the match has ended. A value of 0 or less,
 * or above 240 minutes, keeps the length in force and records why.
 * Before START the phases follow the report provisionally; after START only
 * the end moves.
 */
export function withMatchDuration(state: CryptoBattleState, reported: unknown): CryptoBattleState {
  if (reported === undefined || state.phase === "ended") return state;
  const read = readMatchDuration(reported);
  if (!read.ok) {
    return state.matchDurationRejection === read.rejection ? state : { ...state, matchDurationRejection: read.rejection };
  }
  const { matchDurationRejection: _accepted, ...rest } = state;
  const accepted = state.platformMatchDurationMs === read.durationMs && state.matchDurationRejection === undefined
    ? state : { ...rest, platformMatchDurationMs: read.durationMs };
  const start = accepted.startedAtMs;
  if (start === undefined) {
    const provisional = thirds(read.durationMs);
    return provisional.matchDurationMs === accepted.config.matchDurationMs
      && provisional.phaseBoundaries.buildToPressureMs === accepted.config.phaseBoundaries.buildToPressureMs
      && provisional.phaseBoundaries.pressureToEndgameMs === accepted.config.phaseBoundaries.pressureToEndgameMs
      ? accepted : { ...accepted, config: { ...accepted.config, ...provisional } };
  }
  const matchDurationMs = Math.max(0, read.durationMs - start);
  if (matchDurationMs === accepted.config.matchDurationMs) return accepted;
  const config = { ...accepted.config, matchDurationMs };
  return { ...accepted, ...rescheduled(accepted, config), config };
}

/** At START the phases are fixed for the rest of the match from the time left. */
export function startedTiming(state: CryptoBattleState): CryptoBattleState {
  const reported = state.platformMatchDurationMs;
  return reported === undefined || state.startedAtMs === undefined ? state
    : { ...state, config: { ...state.config, ...thirds(Math.max(0, reported - state.startedAtMs)) } };
}

/** What the waiting screen shows: how long the match can still run if it starts now. */
export function waitingRemainingMs(state: CryptoBattleState): number {
  return state.platformMatchDurationMs === undefined
    ? state.config.matchDurationMs
    : Math.max(0, state.platformMatchDurationMs - (state.nowMs ?? 0));
}
