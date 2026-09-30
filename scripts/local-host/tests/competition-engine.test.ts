import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CompetitionEngine } from "../competition-engine";
import { DockerHostingEngine } from "../docker-engine";
import type { Context, EngineResult, ScoreEvent } from "../model";

// The HTTP suite uses the real Battle plugin; this isolates the existing SQL
// scorer boundary, without claiming a live Docker deployment.
test("SQL awards and hint costs preserve Battle points and never pass Battle jobs to Docker", async () => {
  const data = mkdtempSync(join(tmpdir(), "tenka-mixed-score-"));
  const engine = new CompetitionEngine(fileURLToPath(new URL("../../../", import.meta.url)), data);
  const at = "2026-09-27T00:00:00.000Z";
  const battle: ScoreEvent = {
    jobId: "battle-job",
    problemId: "ac26-crypto-battle",
    source: "coordination",
    points: 30,
    result: "ok",
    occurredAt: at,
  };
  const bonus: ScoreEvent = {
    ...battle,
    jobId: "sql-job",
    problemId: "sqli-demo",
    source: "gate_bonus",
    points: 50,
  };
  const context: Context = {
    now: Date.parse(at),
    event: {
      eventId: "e",
      name: "mixed",
      status: "READY",
      createdAt: at,
      updatedAt: at,
      startsAt: at,
      expiresAt: 0,
      scoringLocked: false,
      scoreboardFreezeMinutes: 0,
      problems: [...engine.catalog()],
    },
    team: {
      teamId: "a",
      eventId: "e",
      internalSlug: "a",
      displayName: "Alpha",
      loginKey: "test-only",
      snapshot: null,
      score: 80,
      completedProblems: 0,
      scoreEvents: [battle, bonus],
    },
    jobs: engine.catalog().map((problem, index) => ({
      jobId: `${index}`,
      eventId: "e",
      teamId: "a",
      problemId: problem.problemId,
      definition: problem.definition,
      offset: 0,
      status: "COMPLETE",
      unit: null,
    })),
  };
  const sqlEvent = {
    ...battle,
    jobId: "sql-job",
    problemId: "sqli-demo",
    source: "flag",
    points: 100,
  };
  const result: EngineResult = {
    status: 200,
    body: {},
    snapshot: "SQL snapshot",
    score: 100,
    completedProblems: 1,
    scoreEvents: [sqlEvent],
  };
  const submit = spyOn(DockerHostingEngine.prototype, "submit").mockImplementation(
    async (input) => {
      expect(input.event.problems.map((problem) => problem.problemId)).toEqual(["sqli-demo"]);
      expect(input.jobs.map((job) => job.problemId)).toEqual(["sqli-demo"]);
      return result;
    },
  );
  const hint = spyOn(DockerHostingEngine.prototype, "hint").mockResolvedValue({
    ...result,
    score: 98,
    scoreEvents: [sqlEvent, { ...sqlEvent, source: "hint", points: -2 }],
  });
  try {
    const answer = await engine.submit(context, { problemId: "sqli-demo", flag: "test-only" });
    expect(answer.score).toBe(180);
    expect(answer.scoreEvents.filter((event) => event.source === "gate_bonus")).toEqual([bonus]);
    expect(answer.snapshot).toBe("SQL snapshot");
    expect(answer.completedProblems).toBe(1);
    expect(answer.scoreEvents.filter((event) => event.source === "coordination")).toEqual([battle]);
    const hinted = await engine.hint(context, "sqli-demo", "1");
    expect(hinted.score).toBe(178);
    expect(hinted.scoreEvents.reduce((sum, event) => sum + event.points, 0)).toBe(178);
  } finally {
    submit.mockRestore();
    hint.mockRestore();
    rmSync(data, { recursive: true, force: true });
  }
});
