import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { GetCommand, type PutCommand } from "@aws-sdk/lib-dynamodb";
import type { EvaluationRecord, RunRecord } from "@tenkacloud/endpoint-eval";
import { describe, expect, it, vi } from "vitest";
import { DdbRunRepository } from "../../lib/endpoint-eval/handlers/eval-handler/ddb-run-repository.js";

const stageResult = { stageId: "0-deploy", title: "Deploy", passed: true, probes: [] };
const run: RunRecord = { runId: "r1", challengeId: "c1", seed: "s1", createdAt: 1000 };

function repoWith(sendImpl: (cmd: unknown) => unknown) {
  const send = vi.fn(async (cmd: unknown) => sendImpl(cmd));
  const ddb = { send } as unknown as DynamoDBDocumentClient;
  // 固定 now で expiresAt を決定的にする。
  const repo = new DdbRunRepository(ddb, "EvalRuns", 100, () => 10_000);
  return { repo, send };
}

describe("DdbRunRepository", () => {
  it("should write a run with a TTL-stamped META item", async () => {
    const { repo, send } = repoWith(() => ({}));
    await repo.createRun(run);
    const input = (send.mock.calls[0][0] as PutCommand).input;
    expect(input.Item).toMatchObject({ PK: "RUN#r1", SK: "META", challengeId: "c1", seed: "s1" });
    expect(input.Item?.expiresAt).toBe(110); // floor(10000/1000) + 100
  });

  it("should round-trip a run via GetItem", async () => {
    const { repo } = repoWith((cmd) =>
      cmd instanceof GetCommand
        ? { Item: { runId: "r1", challengeId: "c1", seed: "s1", createdAt: 1000 } }
        : {},
    );
    expect(await repo.getRun("r1")).toEqual(run);
  });

  it("should return null for a missing run", async () => {
    const { repo } = repoWith(() => ({}));
    expect(await repo.getRun("ghost")).toBeNull();
  });

  it("should write a failed evaluation only to its EVAL# key (no PASS pointer)", async () => {
    const { repo, send } = repoWith(() => ({}));
    const rec: EvaluationRecord = {
      evaluationId: "e1",
      runId: "r1",
      stageId: "0-deploy",
      status: "failed",
      result: { ...stageResult, passed: false },
      createdAt: 2000,
    };
    await repo.putEvaluation(rec);
    expect(send).toHaveBeenCalledTimes(1);
    expect((send.mock.calls[0][0] as PutCommand).input.Item?.SK).toBe("EVAL#e1");
  });

  it("should write a passed evaluation to both EVAL# and PASS# keys (idempotent reissue)", async () => {
    const { repo, send } = repoWith(() => ({}));
    const rec: EvaluationRecord = {
      evaluationId: "e2",
      runId: "r1",
      stageId: "0-deploy",
      status: "passed",
      result: stageResult,
      clearCode: "code",
      createdAt: 2000,
    };
    await repo.putEvaluation(rec);
    const sks = send.mock.calls.map((c) => (c[0] as PutCommand).input.Item?.SK);
    expect(sks).toEqual(["EVAL#e2", "PASS#0-deploy"]);
  });

  it("should find a passed evaluation by stage and map it back", async () => {
    const { repo } = repoWith((cmd) =>
      cmd instanceof GetCommand
        ? {
            Item: {
              evaluationId: "e2",
              runId: "r1",
              stageId: "0-deploy",
              status: "passed",
              result: stageResult,
              clearCode: "code",
              createdAt: 2000,
            },
          }
        : {},
    );
    const found = await repo.findPassedEvaluation("r1", "0-deploy");
    expect(found?.evaluationId).toBe("e2");
    expect(found?.clearCode).toBe("code");
  });

  it("should return null when no passed evaluation exists for the stage", async () => {
    const { repo } = repoWith(() => ({}));
    expect(await repo.findPassedEvaluation("r1", "9-none")).toBeNull();
    expect(await repo.getEvaluation("r1", "ghost")).toBeNull();
  });
});
