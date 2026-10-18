import { predictionKey, predictionTeam } from "./hunt-key.ts";
import type { CryptoBattleState, LastHunt, StoredLastHunt } from "./types.ts";

/** Own latest verdict, not an audit event. Fixed roster replaces only the long target ID. */
export function storeLastHunt(
  state: Pick<CryptoBattleState, "teams">,
  result: LastHunt,
): StoredLastHunt {
  const tuple = [
    Number(predictionKey(state, result.targetTeamId)),
    result.generation,
    result.via === "rotor" ? 2 : result.via === "sudoku" ? 1 : 0,
    result.outcome === "hit" ? 1 : 0,
  ] as const;
  return result.points === undefined ? tuple : [...tuple, result.points];
}

/** Legacy unknown points stay absent. Never infer an old delta from current prices. */
export function readLastHunt(
  state: Pick<CryptoBattleState, "teams">,
  value: StoredLastHunt,
): LastHunt {
  if (!Array.isArray(value)) return value as LastHunt;
  const [target, generation, via, outcome, points] = value;
  if (
    (value.length !== 4 && value.length !== 5) ||
    !Number.isSafeInteger(generation) ||
    generation < 1 ||
    ![0, 1, 2].includes(via) ||
    ![0, 1].includes(outcome) ||
    (points !== undefined &&
      (typeof points !== "number" || !Number.isFinite(points)))
  )
    throw new Error("Invalid stored HUNT verdict");
  return {
    targetTeamId: predictionTeam(state, String(target)),
    generation,
    ...(via === 0
      ? {}
      : { via: via === 1 ? ("sudoku" as const) : ("rotor" as const) }),
    outcome: outcome === 1 ? "hit" : "miss",
    ...(points === undefined ? {} : { points }),
  };
}
