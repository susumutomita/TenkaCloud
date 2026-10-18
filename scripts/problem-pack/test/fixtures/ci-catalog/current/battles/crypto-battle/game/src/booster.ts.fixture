import type { CryptoBattleState, EndgameBooster, HintBoosterProjection } from "./types.ts";

/** #659 §9: starts on distribution, never on a participant-controlled clock. */
export const HINT_BOOSTER_MS = 10 * 60_000;

export function boosterStartAt(state: CryptoBattleState): number | undefined {
  return state.startedAtMs === undefined ? undefined
    : state.startedAtMs + state.config.phaseBoundaries.pressureToEndgameMs;
}

/** Old matches past the boundary have no historical ranking to reconstruct. */
export function storedBooster(state: CryptoBattleState): EndgameBooster {
  const stored = state.endgameBooster;
  if (stored === undefined) {
    const start = boosterStartAt(state);
    return start !== undefined && (state.nowMs ?? 0) >= start
      ? { status: "unavailable" } : { status: "pending" };
  }
  if (!stored || typeof stored !== "object"
    || !["pending", "awarded", "unavailable"].includes(stored.status)) {
    throw new Error("booster: invalid stored distribution");
  }
  if (stored.status === "awarded" && (!Array.isArray(stored.teamIds)
    || stored.teamIds.some(id => typeof id !== "string" || !Object.hasOwn(state.teams, id))
    || new Set(stored.teamIds).size !== stored.teamIds.length)) {
    throw new Error("booster: invalid recipient roster");
  }
  return stored;
}

export function awardBooster(boundaryState: CryptoBattleState): EndgameBooster {
  const teams = Object.values(boundaryState.teams);
  // A lone team is also the leader. Practice remains playable without a handicap.
  const lowest = Math.min(...teams.map(team => team.score));
  return { status: "awarded", teamIds: teams.length < 2 ? []
    : teams.filter(team => team.score === lowest).map(team => team.teamId).sort() };
}

export function projectBooster(state: CryptoBattleState, teamId: string): HintBoosterProjection {
  const startsAt = boosterStartAt(state);
  const now = state.nowMs ?? 0;
  const stored = storedBooster(state);
  const startAfterMs = state.config.phaseBoundaries.pressureToEndgameMs;
  const remainingMs = startsAt === undefined ? 0 : Math.max(0,
    Math.min(startsAt + HINT_BOOSTER_MS, state.startedAtMs! + state.config.matchDurationMs) - now);
  const startsInMs = startsAt === undefined ? undefined : Math.max(0, startsAt - now);
  const status = stored.status === "unavailable" ? "unavailable"
    : startsAt === undefined ? "waiting"
    : stored.status === "pending" ? "scheduled"
    : !stored.teamIds.includes(teamId) ? "ineligible"
    : remainingMs > 0 && now >= startsAt ? "active" : "expired";
  return { status, startAfterMs, startsInMs, remainingMs: status === "active" ? remainingMs : 0 };
}
