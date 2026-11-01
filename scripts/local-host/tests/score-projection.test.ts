import { expect, test } from "bun:test";
import { projectScore, projectScoreTimeline } from "@tenkacloud/problem-sdk/internal";
import type { HostedEvent } from "../model";
import { projectedScore, scorePolicies } from "../score";
import { LEGACY_FLAG_STACK, LEGACY_UPTIME_STACK, legacyStackProblem } from "./legacy-aws-fixture";

test("the host reads a saved event's pinned score floor and leaves an unpinned Battle signed", () => {
  const event: HostedEvent = {
    eventId: "saved-event",
    name: "Saved event",
    status: "READY",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    expiresAt: 0,
    scoringLocked: false,
    scoreboardFreezeMinutes: 0,
    problems: [legacyStackProblem(LEGACY_FLAG_STACK), legacyStackProblem(LEGACY_UPTIME_STACK)],
  };
  expect(scorePolicies(event)).toEqual([
    { problemId: "hello-world", scoreFloor: 0 },
    { problemId: "hello-world-battle" },
  ]);
  const entries = [
    { problemId: "hello-world", points: -5 },
    { problemId: "hello-world-battle", points: -100 },
  ].map((entry, index) => ({
    ...entry,
    jobId: `job-${String(index)}`,
    source: "flag",
    result: "wrong" as const,
    occurredAt: new Date(index).toISOString(),
  }));
  expect(projectedScore(event, entries)).toEqual({
    total: -100,
    byProblem: { "hello-world": 0, "hello-world-battle": -100 },
  });
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
