import { expect, test } from "bun:test";
import { assertCoordinationRoster } from "../coordination-roster";
import type { Problem } from "../model";

const battle = (problemId: string): Problem => ({
  problemId,
  name: problemId,
  runtime: "coordination",
  definition: JSON.stringify({ metadata: {} }),
});

test("a retained two-seat Battle still admits exactly two teams", () => {
  for (const problemId of ["pi-siege", "session-defense", "tenant-boundary-duel"]) {
    expect(() => assertCoordinationRoster([battle(problemId)], 2)).not.toThrow();
    for (const teams of [1, 3])
      expect(() => assertCoordinationRoster([battle(problemId)], teams)).toThrow(
        `${problemId} requires exactly 2 teams.`,
      );
  }
  expect(() => assertCoordinationRoster([battle("crypto-battle")], 3)).not.toThrow();
});
