import { describe, expect, test } from "bun:test";
import { createMatch, type HostPlugin, transitionMatch } from "../coordination-core";

const plugin: HostPlugin = {
  initialState: (ctx) => ({
    scores: Object.fromEntries(ctx.teamIds.map((id) => [id, 0])),
    secret: ctx.matchSecret,
  }),
  validateOp: (_, __, op) =>
    typeof op === "number" ? { ok: true } : { ok: false, error: "number_required" },
  applyOp: (value, teamId, op) => {
    const state = value as { scores: Record<string, number>; secret: string };
    return {
      ...state,
      scores: { ...state.scores, [teamId]: required(state.scores[teamId]) + (op as number) },
    };
  },
  projectForTeam: (state, teamId) => ({
    score: (state as { scores: Record<string, number> }).scores[teamId],
  }),
  teamScores: (state) => (state as { scores: Record<string, number> }).scores,
};

describe("durable local coordination transitions", () => {
  test("issues different private match secrets and never projects them", () => {
    const ctx = { eventId: "same-public-event", teamIds: ["a", "b"] };
    const first = createMatch(plugin, ctx),
      second = createMatch(plugin, ctx);
    expect(first.matchSecret).not.toBe(second.matchSecret);
    expect(JSON.stringify(plugin.projectForTeam(first.state, "a"))).not.toContain(
      first.matchSecret,
    );
  });
  test("awards absolute scores, preserves input and rejects another roster", () => {
    const first = createMatch(plugin, { eventId: "e", teamIds: ["a", "b"] });
    const next = transitionMatch(plugin, first, ["a", "b"], 0, { teamId: "a", op: 30 });
    expect(first.scores.a).toBe(0);
    expect(next.deltas).toEqual({ a: 30, b: 0 });
    expect(transitionMatch(plugin, next.match, ["a", "b"], 0).deltas.a).toBe(0);
    expect(() => transitionMatch(plugin, first, ["a", "b"], 0, { teamId: "c", op: 30 })).toThrow(
      "roster",
    );
  });
  test("rejects malformed operations and incompatible saved state without resetting", () => {
    const first = createMatch(plugin, { eventId: "e", teamIds: ["a"] });
    expect(transitionMatch(plugin, first, ["a"], 0, { teamId: "a", op: {} }).rejection).toBe(
      "number_required",
    );
    expect(() => transitionMatch(plugin, { ...first, stateSchemaVersion: 999 }, ["a"], 0)).toThrow(
      "schema",
    );
    expect(first.scores.a).toBe(0);
  });
});

function required<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("Expected a present test value.");
  return value;
}
