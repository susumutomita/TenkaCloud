import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { projectScore, projectScoreTimeline } from "@tenkacloud/problem-sdk/internal";
import { cloudFormationCatalog } from "../cloudformation-engine";

test("only the new reviewed hello-world definition pins a zero score floor", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const problems = cloudFormationCatalog(root);
  const hello = JSON.parse(
    problems.find((p) => p.problemId === "hello-world")?.definition ?? "null",
  );
  const battle = JSON.parse(
    problems.find((p) => p.problemId === "hello-world-battle")?.definition ?? "null",
  );
  expect(hello.scoreFloor).toBe(0);
  expect(battle.scoreFloor).toBeUndefined();
});

test("a pinned floor projects per-problem cumulative debt and leaves Battle signed", () => {
  const policies = [
    { problemId: "hello-world", scoreFloor: 0 },
    { problemId: "hello-world-battle" },
  ];
  const entries = [
    { problemId: "hello-world", points: -5 },
    { problemId: "hello-world", points: 100 },
    { problemId: "hello-world-battle", points: -100 },
  ];
  expect(projectScoreTimeline(policies, entries)).toEqual([0, 95, -5]);
  expect(projectScore(policies, entries)).toEqual({
    total: -5,
    byProblem: { "hello-world": 95, "hello-world-battle": -100 },
  });
  expect(entries.map((entry) => entry.points)).toEqual([-5, 100, -100]);
  expect(projectScore([{ problemId: "hello-world" }], entries.slice(0, 1)).total).toBe(-5);
});

test("hint debt and gate bonus share the gate problem's cumulative projection", () => {
  const policy = [{ problemId: "hello-world", scoreFloor: 0 }];
  const entries = [
    { problemId: "hello-world", points: -20 },
    { problemId: "hello-world", points: -30 },
    { problemId: "hello-world", points: 100 },
  ];
  expect(projectScoreTimeline(policy, entries)).toEqual([0, 0, 50]);
  expect(projectScore(policy, entries).total).toBe(50);
});
