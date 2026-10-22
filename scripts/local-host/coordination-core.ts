import { randomBytes } from "node:crypto";
import {
  type CoordinationContext,
  type CoordinationPlugin,
  type CoordinationTiming,
  dispatchOp,
} from "@tenkacloud/coordination-plugin-sdk";
import {
  pluginStateSchemaVersion,
  reconcileStateSchema,
} from "../lib/coordination-state-schema.js";

export type HostPlugin = CoordinationPlugin<unknown, unknown>;
export interface LocalMatch {
  state: unknown;
  stateSchemaVersion: number;
  matchSecret: string;
  version: number;
  scores: Record<string, number>;
}
/** The Battle clock a transition runs at; both values already net of scoring-lock pauses. */
export interface MatchClock {
  readonly elapsedMs: number;
  readonly timing: CoordinationTiming;
}
export interface MatchTransition {
  match: LocalMatch;
  deltas: Record<string, number>;
  rejection?: string;
}

/** Server-owned state only. The caller persists this together with every team's score. */
export function createMatch(plugin: HostPlugin, context: CoordinationContext): LocalMatch {
  const matchSecret = randomBytes(32).toString("hex");
  return {
    state: plugin.initialState({ ...context, matchSecret }),
    stateSchemaVersion: pluginStateSchemaVersion(plugin),
    matchSecret,
    version: 0,
    scores: Object.fromEntries(context.teamIds.map((teamId) => [teamId, 0])),
  };
}

/** Pure, disposable transition: a rejected move may still advance the server clock. */
export function transitionMatch(
  plugin: HostPlugin,
  previous: LocalMatch,
  teamIds: readonly string[],
  clock: MatchClock,
  move?: { teamId: string; op: unknown },
): MatchTransition {
  if (!Number.isSafeInteger(clock.elapsedMs) || clock.elapsedMs < 0)
    throw new Error("Invalid match clock.");
  if (move && !teamIds.includes(move.teamId)) throw new Error("Team is outside the event roster.");
  const reconciled = reconcileStateSchema(plugin, structuredClone(previous));
  if (reconciled.kind !== "ok") throw new Error(`Cannot load match schema: ${reconciled.reason}`);
  let state =
    plugin.tickOnRequest && plugin.tick
      ? plugin.tick(reconciled.state, clock.elapsedMs, clock.timing)
      : reconciled.state;
  let rejection: string | undefined;
  if (move) {
    const result = dispatchOp(plugin, state, move.teamId, move.op);
    if (result.ok) state = result.state;
    else rejection = result.error;
  }
  const scores = plugin.teamScores?.(state) ?? previous.scores;
  const deltas = scoreDeltas(scores, previous.scores, teamIds);
  return {
    match: {
      state,
      stateSchemaVersion: pluginStateSchemaVersion(plugin),
      matchSecret: previous.matchSecret,
      version: previous.version + 1,
      scores: { ...scores },
    },
    deltas,
    ...(rejection ? { rejection } : {}),
  };
}

function scoreDeltas(
  scores: Record<string, number>,
  previous: Record<string, number>,
  teamIds: readonly string[],
): Record<string, number> {
  if (Object.keys(scores).some((teamId) => !teamIds.includes(teamId)))
    throw new Error("Plugin returned a score outside the event roster.");
  const deltas: Record<string, number> = {};
  for (const teamId of teamIds) {
    const score = scores[teamId];
    if (typeof score !== "number" || !Number.isFinite(score))
      throw new Error("Plugin returned an invalid score.");
    deltas[teamId] = score - (previous[teamId] ?? 0);
  }
  return deltas;
}
