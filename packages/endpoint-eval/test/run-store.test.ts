import { describe, expect, it } from "vitest";
import { type EvaluationRecord, InMemoryRunRepository, type RunRecord } from "../src/run-store.js";
import type { StageResult } from "../src/stage.js";

const run: RunRecord = {
  runId: "run-1",
  challengeId: "cloudflare-api-security-001",
  seed: "seed-xyz",
  createdAt: 1_000,
};

const stageResult: StageResult = { stageId: "0-deploy", title: "Deploy", passed: true, probes: [] };

function evalRec(over: Partial<EvaluationRecord> = {}): EvaluationRecord {
  return {
    evaluationId: "ev-1",
    runId: "run-1",
    stageId: "0-deploy",
    status: "passed",
    result: stageResult,
    clearCode: "code-1",
    createdAt: 2_000,
    ...over,
  };
}

describe("InMemoryRunRepository", () => {
  it("should round-trip a run", async () => {
    const repo = new InMemoryRunRepository();
    await repo.createRun(run);
    expect(await repo.getRun("run-1")).toEqual(run);
    expect(await repo.getRun("missing")).toBeNull();
  });

  it("should round-trip an evaluation", async () => {
    const repo = new InMemoryRunRepository();
    await repo.putEvaluation(evalRec());
    expect(await repo.getEvaluation("run-1", "ev-1")).toEqual(evalRec());
    expect(await repo.getEvaluation("run-1", "nope")).toBeNull();
  });

  it("should find a passed evaluation for idempotent clear-code reissue", async () => {
    const repo = new InMemoryRunRepository();
    await repo.putEvaluation(
      evalRec({ evaluationId: "ev-fail", status: "failed", clearCode: undefined }),
    );
    expect(await repo.findPassedEvaluation("run-1", "0-deploy")).toBeNull();
    await repo.putEvaluation(evalRec({ evaluationId: "ev-pass" }));
    const found = await repo.findPassedEvaluation("run-1", "0-deploy");
    expect(found?.evaluationId).toBe("ev-pass");
  });

  it("should not cross runs or stages when searching passed evaluations", async () => {
    const repo = new InMemoryRunRepository();
    await repo.putEvaluation(evalRec({ evaluationId: "ev-other-stage", stageId: "1-input" }));
    expect(await repo.findPassedEvaluation("run-1", "0-deploy")).toBeNull();
  });
});
