import { retainCurrentRsaGuards } from "./hunt-success.ts";
import { expandHuntAttempts, packHuntAttempts } from "./hunt-budget.ts";
import type { CryptoBattleState } from "./types.ts";

type Teams = CryptoBattleState["teams"];
type Roster = {
  ids: readonly string[];
  positions: ReadonlyMap<string, number>;
};
const rosterCache = new WeakMap<Teams, Roster>();
let lastRoster: Roster | undefined;

/** Reducer team maps are immutable; memoization only avoids repeated sorting. */
export function rosterOf(teams: Teams) {
  let roster = rosterCache.get(teams);
  if (!roster) {
    const keys = Object.keys(teams);
    // Score updates replace the team map but never its roster. Reuse the one
    // most-recent roster only after checking the entire key set; this also
    // handles interleaved matches and opaque IDs without retaining old states.
    if (
      lastRoster?.ids.length === keys.length &&
      keys.every((id) => lastRoster!.positions.has(id))
    )
      roster = lastRoster;
    else {
      const ids = keys.sort();
      roster = { ids, positions: new Map(ids.map((id, index) => [id, index])) };
      lastRoster = roster;
    }
    rosterCache.set(teams, roster);
  }
  return roster;
}

/** Logical Shamir/RPS identity; successful-HUNT records keep this public-ID form. */
export function huntKey(
  attackerTeamId: string,
  targetTeamId: string,
  generation: number,
): string {
  return JSON.stringify([attackerTeamId, targetTeamId, generation]);
}

/**
 * Schema 4 stores budget keys using positions in the fixed, sorted match roster.
 * JSON numbers cannot collide with the old JSON string IDs. No roster field or
 * shared budget is added, and sorting makes object insertion order irrelevant.
 */
export function storedHuntKey(
  state: Pick<CryptoBattleState, "teams">,
  logicalKey: string,
): string {
  const parts: unknown[] = JSON.parse(logicalKey);
  const offset = parts.length === 4 && parts[0] === "sudoku" ? 1 : 0;
  if (
    parts.length !== offset + 3 ||
    typeof parts[offset] !== "string" ||
    typeof parts[offset + 1] !== "string" ||
    !Number.isSafeInteger(parts[offset + 2])
  )
    throw new Error("Invalid logical HUNT budget key");
  const roster = rosterOf(state.teams);
  const attacker = roster.positions.get(parts[offset] as string),
    target = roster.positions.get(parts[offset + 1] as string);
  if (attacker === undefined || target === undefined)
    throw new Error("HUNT budget references an unknown team");
  return JSON.stringify([
    ...(offset ? ["sudoku"] : []),
    attacker,
    target,
    parts[offset + 2],
  ]);
}

export function compactHuntAttempts(
  state: CryptoBattleState,
): CryptoBattleState["huntAttempts"] {
  const attempts: Record<string, number> = {};
  for (const [key, count] of Object.entries(state.huntAttempts)) {
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
      throw new Error("Invalid HUNT budget count");
    attempts[storedHuntKey(state, key)] = count;
  }
  return attempts;
}

/** v4 already wrote roster positions; validate without treating them as IDs. */
export function validateStoredHuntAttempts(
  state: CryptoBattleState,
): CryptoBattleState["huntAttempts"] {
  const roster = rosterOf(state.teams).ids;
  for (const [key, count] of Object.entries(state.huntAttempts)) {
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
      throw new Error("Invalid HUNT budget count");
    const parts: unknown = JSON.parse(key);
    if (!Array.isArray(parts))
      throw new Error("Invalid stored HUNT budget key");
    const offset = parts[0] === "sudoku" ? 1 : 0;
    if (
      parts.length !== offset + 3 ||
      parts.slice(offset).some((n) => !Number.isSafeInteger(n))
    )
      throw new Error("Invalid stored HUNT budget key");
    const attacker = roster[parts[offset]],
      target = roster[parts[offset + 1]],
      generation = parts[offset + 2];
    if (attacker === undefined || target === undefined || generation < 1)
      throw new Error("Invalid stored HUNT budget identity");
    const logical = JSON.stringify([
      ...(offset ? ["sudoku"] : []),
      attacker,
      target,
      generation,
    ]);
    if (storedHuntKey(state, logical) !== key)
      throw new Error("Non-canonical stored HUNT budget key");
  }
  return state.huntAttempts;
}

/** Old-generation counters have no legal caller except a reserved RPS refund. */
export function pruneRetiredHuntAttempts(
  state: CryptoBattleState,
): CryptoBattleState {
  const roster = rosterOf(state.teams).ids;
  const reserved = new Set<string>();
  for (const c of state.contracts)
    for (const [attacker, [, generation]] of Object.entries(
      c.rps?.predictions ?? {},
    ))
      reserved.add(
        storedHuntKey(
          state,
          huntKey(predictionTeam(state, attacker), c.teamId, generation),
        ),
      );
  const expanded = expandHuntAttempts(state);
  const entries = Object.entries(expanded).filter(([key]) => {
    const parts = JSON.parse(key) as (string | number)[];
    const offset = parts[0] === "sudoku" ? 1 : 0;
    const target = roster[Number(parts[offset + 1])];
    return (
      (target !== undefined &&
        state.teams[target]?.generation === parts[offset + 2]) ||
      reserved.has(key)
    );
  });
  return entries.length === Object.keys(expanded).length
    ? state
    : {
        ...state,
        huntAttempts: packHuntAttempts({
          ...state,
          huntAttempts: Object.fromEntries(entries),
        }),
      };
}

/** Judge-private pending predictions use the same fixed-roster identity. */
export function predictionKey(
  state: Pick<CryptoBattleState, "teams">,
  teamId: string,
): string {
  const index = rosterOf(state.teams).positions.get(teamId);
  if (index === undefined)
    throw new Error("Prediction references an unknown team");
  return String(index);
}
export function predictionTeam(
  state: Pick<CryptoBattleState, "teams">,
  key: string,
): string {
  const index = Number(key),
    teamId = rosterOf(state.teams).ids[index];
  if (
    !Number.isSafeInteger(index) ||
    String(index) !== key ||
    teamId === undefined
  )
    throw new Error("Invalid prediction roster position");
  return teamId;
}

/**
 * Schema 10: RSA permits all-to-all attacks without LEAK. Pack the two fixed
 * roster positions into one base-36 integer; logical legacy HUNT keys start with "[",
 * so this prefix cannot collide with a team ID or another method's history.
 */
export function rsaHuntKey(
  state: Pick<CryptoBattleState, "teams">,
  attacker: string,
  target: string,
  generation: number,
): string {
  const width = rosterOf(state.teams).ids.length;
  const pair =
    Number(predictionKey(state, attacker)) * width +
    Number(predictionKey(state, target));
  return `r${pair.toString(36)}:${generation}`;
}

/** A retired RSA generation cannot be submitted; other methods retain their history. */
export function pruneRetiredRsaHunts(
  state: CryptoBattleState,
): CryptoBattleState {
  const successfulHunts = retainCurrentRsaGuards(state);
  return successfulHunts.length === state.successfulHunts.length
    ? state
    : { ...state, successfulHunts };
}
