import { QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ParticipantSharedResources } from "../../lib/problem-deploy/handlers/participant-handler/shared";
import { submitFlag } from "../../lib/problem-deploy/handlers/participant-handler/submit-flag";
import type { ProblemScoringMetadata } from "../../lib/utils/scoring-metadata";

function buildShared(): {
  shared: ParticipantSharedResources;
  ddbSend: ReturnType<typeof vi.fn>;
} {
  const ddbSend = vi.fn();
  const shared: ParticipantSharedResources = {
    tableName: "TestDeployments",
    eventsTableName: "TestEvents",
    ddb: { send: ddbSend } as unknown as ParticipantSharedResources["ddb"],
    problemsScoring: {},
  };
  return { shared, ddbSend };
}

const sampleRow = (over: Record<string, unknown> = {}) => ({
  PK: "DEPLOYMENT#JOB1",
  SK: "META",
  jobId: "JOB1",
  problemId: "hello-world",
  tenantId: "tenant-acme",
  teamName: "alpha",
  namePrefix: "tc-hello-world-alpha",
  status: "COMPLETE",
  // CFn array shape を模す。parseStackOutputs が両形式を解釈する。
  stackOutputs: JSON.stringify([
    { OutputKey: "ParameterValue", OutputValue: "Hello from tc-hello-world-alpha" },
    { OutputKey: "ParameterName", OutputValue: "/tc-hello-world-alpha/hello" },
  ]),
  expiresAt: 9_999_999_999,
  ...over,
});

const flagScoring: Record<string, ProblemScoringMetadata> = {
  "hello-world": {
    kind: "flag",
    flagOutputKey: "ParameterValue",
    points: 100,
  },
};

describe("submitFlag", () => {
  let shared: ParticipantSharedResources;
  let ddbSend: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    const built = buildShared();
    shared = built.shared;
    ddbSend = built.ddbSend;
  });

  it("teamLoginKey が一致する row が無いときは unauthorized を返すべき", async () => {
    ddbSend.mockResolvedValueOnce({ Items: [] });
    const out = await submitFlag(
      shared,
      flagScoring,
      "BAD_KEY",
      "hello-world",
      "Hello from tc-...",
    );
    expect(out).toEqual({ kind: "unauthorized" });
  });

  it("scoring 設定が無い problemId は not_flag_problem を返すべき", async () => {
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow({ problemId: "no-scoring" })] });
    const out = await submitFlag(shared, flagScoring, "KEY", "no-scoring", "anything");
    expect(out).toEqual({ kind: "not_flag_problem" });
  });

  it("既に flagSubmitted=true なら already_scored を返すべき (= 重複加算しない)", async () => {
    ddbSend.mockResolvedValueOnce({
      Items: [sampleRow({ flagSubmitted: true, score: 100 })],
    });
    const out = await submitFlag(
      shared,
      flagScoring,
      "KEY",
      "hello-world",
      "Hello from tc-hello-world-alpha",
    );
    expect(out).toEqual({ kind: "already_scored", totalScore: 100 });
    // UpdateItem は呼ばれないこと (= Query の 1 回のみ)
    expect(ddbSend).toHaveBeenCalledTimes(1);
  });

  it("stackOutputs に flagOutputKey が無いとき (= deploy 未完了) は no_outputs を返すべき", async () => {
    ddbSend.mockResolvedValueOnce({
      Items: [sampleRow({ stackOutputs: undefined })],
    });
    const out = await submitFlag(shared, flagScoring, "KEY", "hello-world", "anything");
    expect(out).toEqual({ kind: "no_outputs" });
  });

  it("submitted flag が expected と一致しなければ wrong + scoreDelta=0 を返すべき (penalty 未設定なら UpdateItem 呼ばない)", async () => {
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow({ score: 25, wrongAnswerCount: 3 })] });
    const out = await submitFlag(shared, flagScoring, "KEY", "hello-world", "wrong-answer");
    // Issue #817: penalty=0 / 未設定の場合は scoreDelta=0、 既存 wrongCount を返す互換挙動。
    expect(out).toEqual({ kind: "wrong", scoreDelta: 0, totalScore: 25, wrongCount: 3 });
    expect(ddbSend).toHaveBeenCalledTimes(1); // Query のみ、Update なし (= Free Tier WCU 節約)
  });

  it("Issue #817: wrongAnswerPenalty > 0 で不正解なら score を減算 + wrongAnswerCount を ADD すべき", async () => {
    const penaltyScoring: Record<string, ProblemScoringMetadata> = {
      "hello-world": {
        kind: "flag",
        flagOutputKey: "ParameterValue",
        points: 100,
        wrongAnswerPenalty: 10,
      },
    };
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow({ score: 30, wrongAnswerCount: 2 })] });
    // UpdateItem 後の Attributes (= score=30-10=20、 wrongAnswerCount=2+1=3)
    ddbSend.mockResolvedValueOnce({ Attributes: { score: 20, wrongAnswerCount: 3 } });
    // writeScoreEvent (= PutItem) の mock
    ddbSend.mockResolvedValueOnce({});

    const out = await submitFlag(shared, penaltyScoring, "KEY", "hello-world", "wrong-answer");

    expect(out).toEqual({ kind: "wrong", scoreDelta: -10, totalScore: 20, wrongCount: 3 });
    expect(ddbSend).toHaveBeenCalledTimes(3); // Query + UpdateItem + score event Put
    const updateCmd = ddbSend.mock.calls[1]?.[0] as UpdateCommand;
    expect(updateCmd.input.UpdateExpression).toContain("ADD wrongAnswerCount :one, score :neg");
    expect(updateCmd.input.ExpressionAttributeValues?.[":neg"]).toBe(-10);
    expect(updateCmd.input.ConditionExpression).toContain("attribute_not_exists(flagSubmitted)");
  });

  it("Issue #817: penalty で score が負数になっても totalScore は 0 で clamp して返すべき", async () => {
    const penaltyScoring: Record<string, ProblemScoringMetadata> = {
      "hello-world": {
        kind: "flag",
        flagOutputKey: "ParameterValue",
        points: 100,
        wrongAnswerPenalty: 50,
      },
    };
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow({ score: 10, wrongAnswerCount: 0 })] });
    ddbSend.mockResolvedValueOnce({ Attributes: { score: -40, wrongAnswerCount: 1 } });
    ddbSend.mockResolvedValueOnce({});

    const out = await submitFlag(shared, penaltyScoring, "KEY", "hello-world", "wrong-answer");

    expect(out).toEqual({ kind: "wrong", scoreDelta: -50, totalScore: 0, wrongCount: 1 });
  });

  it("Issue #817: penalty 経路で flagSubmitted=true との race (= CCF) は already_scored に倒すべき", async () => {
    const penaltyScoring: Record<string, ProblemScoringMetadata> = {
      "hello-world": {
        kind: "flag",
        flagOutputKey: "ParameterValue",
        points: 100,
        wrongAnswerPenalty: 10,
      },
    };
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow({ score: 100 })] });
    ddbSend.mockImplementationOnce(async () => {
      const err: Error & { name?: string } = new Error("conditional check failed");
      err.name = "ConditionalCheckFailedException";
      throw err;
    });

    const out = await submitFlag(shared, penaltyScoring, "KEY", "hello-world", "wrong-answer");

    expect(out).toEqual({ kind: "already_scored", totalScore: 100 });
  });

  it("正解なら ADD score :pts SET flagSubmitted=true で UpdateItem し ok を返すべき", async () => {
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow()] });
    ddbSend.mockResolvedValueOnce({ Attributes: { score: 100 } });
    const out = await submitFlag(
      shared,
      flagScoring,
      "KEY",
      "hello-world",
      "Hello from tc-hello-world-alpha",
    );
    expect(out).toEqual({ kind: "ok", scoreDelta: 100, totalScore: 100 });
    // 1: GSI2 query, 2: UpdateItem(score), 3: PutItem(score event log)
    expect(ddbSend).toHaveBeenCalledTimes(3);
    const updateCmd = ddbSend.mock.calls[1]?.[0] as UpdateCommand;
    expect(updateCmd).toBeInstanceOf(UpdateCommand);
    expect(updateCmd.input.UpdateExpression).toContain("ADD score :pts");
    expect(updateCmd.input.UpdateExpression).toContain("flagSubmitted = :true");
    expect(updateCmd.input.ConditionExpression).toContain("attribute_not_exists(flagSubmitted)");
  });

  it("trim した値が一致すれば ok を返すべき (= 末尾改行などで弾かない)", async () => {
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow()] });
    ddbSend.mockResolvedValueOnce({ Attributes: { score: 100 } });
    const out = await submitFlag(
      shared,
      flagScoring,
      "KEY",
      "hello-world",
      "  Hello from tc-hello-world-alpha\n",
    );
    expect(out.kind).toBe("ok");
  });

  it("ConditionalCheckFailedException は already_scored で吸収するべき (= 並行 submit 対策)", async () => {
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow({ score: 0 })] });
    const condErr = Object.assign(new Error("conditional check failed"), {
      name: "ConditionalCheckFailedException",
    });
    ddbSend.mockRejectedValueOnce(condErr);
    const out = await submitFlag(
      shared,
      flagScoring,
      "KEY",
      "hello-world",
      "Hello from tc-hello-world-alpha",
    );
    expect(out).toEqual({ kind: "already_scored", totalScore: 100 });
  });

  it("Query は GSI2 を `TEAMKEY#<key>` で叩くべき", async () => {
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow()] });
    ddbSend.mockResolvedValueOnce({ Attributes: { score: 100 } });
    await submitFlag(
      shared,
      flagScoring,
      "MYKEY",
      "hello-world",
      "Hello from tc-hello-world-alpha",
    );
    const queryCmd = ddbSend.mock.calls[0]?.[0] as QueryCommand;
    expect(queryCmd).toBeInstanceOf(QueryCommand);
    expect(queryCmd.input.IndexName).toBe("GSI2");
    expect(queryCmd.input.ExpressionAttributeValues).toEqual({ ":pk": "TEAMKEY#MYKEY" });
  });
});
