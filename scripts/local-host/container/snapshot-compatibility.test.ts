import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContainerProblem } from "./manifest";
import { revealContainerHint, submitFlag } from "./scoring";
import { createContainerState } from "./session";
import {
  parseLocalPlaySnapshot,
  restoreLocalPlayState,
  snapshotLocalPlayState,
} from "./state-store";
import { verifySubmission } from "./verify-client";
import { teamView } from "./views";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});
const iso = "2026-09-30T00:00:00.000Z";
const problem: ContainerProblem = {
  problemId: "sqli-demo",
  name: "SQL",
  description: "private answer",
  instructions: "Find the flag",
  writeup: "private writeup",
  writeupI18n: "private English writeup",
  i18n: { en: { name: "SQL", description: "private English answer", instructions: "Find it" } },
  problemDir: "/fixture",
  composePath: "/fixture/compose.yml",
  composeProjectName: "fixture",
  challengeEndpoints: { Web: "http://127.0.0.1:18080/" },
  verifyUrl: "http://127.0.0.1:18081/verify",
  secretEnv: [],
  scoring: {
    kind: "verify",
    points: 100,
    wrongAnswerPenalty: 10,
    hints: [
      {
        id: "paid",
        content: "private hint",
        penalty: 5,
        i18n: { en: { content: "private English hint" } },
      },
    ],
  },
};
function state(p = problem) {
  return createContainerState([p], {
    teamName: "Team",
    verify: verifySubmission,
    startContainer: async (item) => ({
      problem: item,
      unit: {
        problemId: item.problemId,
        composePath: item.composePath,
        composeProjectName: item.composeProjectName,
        secretEnv: item.secretEnv,
      },
    }),
  });
}
function verifier() {
  const submissions: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const body: unknown = await request.json();
      submissions.push(body);
      const input = body as { submission: string; checkpointId?: string };
      return Response.json({
        correct: input.submission === "correct",
        ...(input.checkpointId ? { checkpointId: input.checkpointId, points: 999 } : {}),
      });
    },
  });
  cleanup.push(() => server.stop(true));
  return { submissions, problem: { ...problem, verifyUrl: new URL("/verify", server.url).href } };
}
const request = (body: unknown) => ({
  method: "POST",
  path: "/portal/me/submit-flag",
  query: {},
  body,
});
test("real verifier requests preserve penalties, gated prose, checkpoint awards and retries", async () => {
  const active = verifier();
  const session = state(active.problem);
  expect(
    await submitFlag(request({ problemId: problem.problemId, flag: "correct" }), session, iso),
  ).toEqual({ status: 409, body: { error: "not_running" } });
  await session.lifecycle.ensureRunning(problem.problemId);
  const before = JSON.stringify(teamView(session, Date.parse(iso)));
  for (const secret of [
    "private answer",
    "private English answer",
    "private writeup",
    "private English writeup",
    "private hint",
    "private English hint",
  ])
    expect(before).not.toContain(secret);
  expect(
    await submitFlag(request({ problemId: problem.problemId, flag: "wrong" }), session, iso),
  ).toEqual({
    status: 200,
    body: { kind: "wrong", scoreDelta: -10, totalScore: -10, wrongCount: 1 },
  });
  expect(revealContainerHint(problem.problemId, "paid", session, iso).body).toMatchObject({
    kind: "ok",
    penaltyApplied: 5,
    totalScore: -15,
    content: "private hint",
  });
  expect(revealContainerHint(problem.problemId, "paid", session, iso).body).toMatchObject({
    kind: "already_revealed",
    penaltyApplied: 0,
    totalScore: -15,
  });
  expect(
    await submitFlag(request({ problemId: problem.problemId, flag: "correct" }), session, iso),
  ).toEqual({ status: 200, body: { kind: "ok", scoreDelta: 100, totalScore: 85 } });
  expect(
    await submitFlag(request({ problemId: problem.problemId, flag: "wrong" }), session, iso),
  ).toEqual({ status: 200, body: { kind: "already_scored", totalScore: 85 } });
  expect(active.submissions).toHaveLength(2);
  expect(JSON.stringify(teamView(session, Date.parse(iso)))).toContain("private English writeup");
  const multi = state({
    ...active.problem,
    scoring: {
      kind: "multi-verify",
      totalPoints: 20,
      checks: [{ id: "one", label: "One", points: 20, wrongAnswerPenalty: 3, hints: [] }],
    },
  });
  await multi.lifecycle.ensureRunning(problem.problemId);
  expect(
    (
      await submitFlag(
        request({ problemId: problem.problemId, flag: "correct", flagId: "missing" }),
        multi,
        iso,
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await submitFlag(
        request({ problemId: problem.problemId, flag: "correct", flagId: "one" }),
        multi,
        iso,
      )
    ).body,
  ).toEqual({ kind: "ok", scoreDelta: 20, totalScore: 20, flagId: "one" });
  expect(active.submissions).toHaveLength(3);
});

test("version 1 progress survives a real SQLite reopen", async () => {
  const active = verifier();
  const source = state(active.problem);
  await source.lifecycle.ensureRunning(problem.problemId);
  await submitFlag(request({ problemId: problem.problemId, flag: "wrong" }), source, iso);
  revealContainerHint(problem.problemId, "paid", source, iso);
  await submitFlag(request({ problemId: problem.problemId, flag: "correct" }), source, iso);
  const snapshot = snapshotLocalPlayState(source);
  expect(snapshot).toEqual({
    version: 1,
    teamName: "Team",
    runtimes: {
      "sqli-demo": {
        solved: ["sqli-demo"],
        revealedHints: [["paid", iso]],
        wrongCounts: [["sqli-demo", 1]],
        score: 85,
      },
    },
    simulatedRuntimes: {},
    scoreEvents: [
      {
        jobId: "local-sqli-demo",
        problemId: "sqli-demo",
        source: "flag",
        points: 100,
        result: "ok",
        occurredAt: iso,
      },
      {
        jobId: "local-sqli-demo",
        problemId: "sqli-demo",
        source: "hint",
        points: -5,
        result: "ok",
        occurredAt: iso,
      },
      {
        jobId: "local-sqli-demo",
        problemId: "sqli-demo",
        source: "flag-wrong",
        points: -10,
        result: "wrong",
        occurredAt: iso,
      },
    ],
  });
  const directory = mkdtempSync(join(tmpdir(), "host-snapshot-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, "snapshot.sqlite");
  const writer = new Database(filename);
  writer.exec("CREATE TABLE snapshots (value TEXT NOT NULL)");
  const insert = writer.prepare("INSERT INTO snapshots VALUES (?)");
  insert.run(JSON.stringify(snapshot));
  insert.finalize();
  writer.close();
  const reader = new Database(filename);
  const select = reader.prepare<{ value: string }, []>("SELECT value FROM snapshots");
  const persisted = select.get();
  select.finalize();
  reader.close();
  if (!persisted) throw new Error("snapshot missing");
  const restored = state(active.problem);
  restoreLocalPlayState(restored, parseLocalPlaySnapshot(persisted.value));
  expect(snapshotLocalPlayState(restored)).toEqual(snapshot);
  expect(restored.lifecycle.statusOf(problem.problemId)).toBe("stopped");
  await restored.lifecycle.ensureRunning(problem.problemId);
  const retry = await submitFlag(
    request({ problemId: problem.problemId, flag: "wrong" }),
    restored,
    iso,
  );
  expect(retry).toEqual({ status: 200, body: { kind: "already_scored", totalScore: 85 } });
  expect(active.submissions).toHaveLength(2);
  expect(snapshotLocalPlayState(restored)).toEqual(snapshot);
  expect(JSON.stringify(teamView(restored, Date.parse(iso)))).toContain("private English writeup");
});

test("invalid version or foreign problem snapshots fail closed without clearing progress", () => {
  const session = state();
  expect(() => parseLocalPlaySnapshot('{"version":2}')).toThrow("unsupported");
  expect(() => parseLocalPlaySnapshot('{"version":1,"teamName":3}')).toThrow("teamName");
  const own = snapshotLocalPlayState(session);
  expect(() =>
    restoreLocalPlayState(session, {
      ...own,
      runtimes: { foreign: { score: 1, solved: [], revealedHints: [], wrongCounts: [] } },
    }),
  ).toThrow("unknown container problem");
  expect(snapshotLocalPlayState(session)).toEqual(own);
});
