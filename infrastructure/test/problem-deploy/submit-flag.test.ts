import { QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ParticipantSharedResources } from "../../lib/problem-deploy/handlers/participant-handler/shared";
import {
  parseProblemsScoring,
  submitFlag,
} from "../../lib/problem-deploy/handlers/participant-handler/submit-flag";

function buildShared(): {
  shared: ParticipantSharedResources;
  ddbSend: ReturnType<typeof vi.fn>;
} {
  const ddbSend = vi.fn();
  const shared: ParticipantSharedResources = {
    tableName: "TestDeployments",
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

const flagScoring = {
  "hello-world": {
    kind: "flag",
    flagOutputKey: "ParameterValue",
    points: 100,
  },
};

describe("parseProblemsScoring", () => {
  it("undefined / 空文字 / 壊れた JSON は空 map を返すべき", () => {
    expect(parseProblemsScoring(undefined)).toEqual({});
    expect(parseProblemsScoring("")).toEqual({});
    expect(parseProblemsScoring("{not-json")).toEqual({});
  });
  it("正常な JSON object はそのまま返すべき", () => {
    expect(parseProblemsScoring(JSON.stringify(flagScoring))).toEqual(flagScoring);
  });
  it("array や primitive は空 map を返すべき (= shape mismatch)", () => {
    expect(parseProblemsScoring(JSON.stringify(["x"]))).toEqual({});
    expect(parseProblemsScoring(JSON.stringify(123))).toEqual({});
  });
});

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
    const out = await submitFlag(shared, flagScoring, "BAD_KEY", "Hello from tc-...");
    expect(out).toEqual({ kind: "unauthorized" });
  });

  it("scoring 設定が無い problemId は not_flag_problem を返すべき", async () => {
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow({ problemId: "no-scoring" })] });
    const out = await submitFlag(shared, flagScoring, "KEY", "anything");
    expect(out).toEqual({ kind: "not_flag_problem" });
  });

  it("既に flagSubmitted=true なら already_scored を返すべき (= 重複加算しない)", async () => {
    ddbSend.mockResolvedValueOnce({
      Items: [sampleRow({ flagSubmitted: true, score: 100 })],
    });
    const out = await submitFlag(shared, flagScoring, "KEY", "Hello from tc-hello-world-alpha");
    expect(out).toEqual({ kind: "already_scored", totalScore: 100 });
    // UpdateItem は呼ばれないこと (= Query の 1 回のみ)
    expect(ddbSend).toHaveBeenCalledTimes(1);
  });

  it("stackOutputs に flagOutputKey が無いとき (= deploy 未完了) は no_outputs を返すべき", async () => {
    ddbSend.mockResolvedValueOnce({
      Items: [sampleRow({ stackOutputs: undefined })],
    });
    const out = await submitFlag(shared, flagScoring, "KEY", "anything");
    expect(out).toEqual({ kind: "no_outputs" });
  });

  it("submitted flag が expected と一致しなければ wrong を返すべき (UpdateItem 呼ばない)", async () => {
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow()] });
    const out = await submitFlag(shared, flagScoring, "KEY", "wrong-answer");
    expect(out).toEqual({ kind: "wrong" });
    expect(ddbSend).toHaveBeenCalledTimes(1); // Query のみ、Update なし
  });

  it("正解なら ADD score :pts SET flagSubmitted=true で UpdateItem し ok を返すべき", async () => {
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow()] });
    ddbSend.mockResolvedValueOnce({ Attributes: { score: 100 } });
    const out = await submitFlag(shared, flagScoring, "KEY", "Hello from tc-hello-world-alpha");
    expect(out).toEqual({ kind: "ok", scoreDelta: 100, totalScore: 100 });
    expect(ddbSend).toHaveBeenCalledTimes(2);
    const updateCmd = ddbSend.mock.calls[1]?.[0] as UpdateCommand;
    expect(updateCmd).toBeInstanceOf(UpdateCommand);
    expect(updateCmd.input.UpdateExpression).toContain("ADD score :pts");
    expect(updateCmd.input.UpdateExpression).toContain("flagSubmitted = :true");
    expect(updateCmd.input.ConditionExpression).toContain("attribute_not_exists(flagSubmitted)");
  });

  it("trim した値が一致すれば ok を返すべき (= 末尾改行などで弾かない)", async () => {
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow()] });
    ddbSend.mockResolvedValueOnce({ Attributes: { score: 100 } });
    const out = await submitFlag(shared, flagScoring, "KEY", "  Hello from tc-hello-world-alpha\n");
    expect(out.kind).toBe("ok");
  });

  it("ConditionalCheckFailedException は already_scored で吸収するべき (= 並行 submit 対策)", async () => {
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow({ score: 0 })] });
    const condErr = Object.assign(new Error("conditional check failed"), {
      name: "ConditionalCheckFailedException",
    });
    ddbSend.mockRejectedValueOnce(condErr);
    const out = await submitFlag(shared, flagScoring, "KEY", "Hello from tc-hello-world-alpha");
    expect(out).toEqual({ kind: "already_scored", totalScore: 100 });
  });

  it("Query は GSI2 を `TEAMKEY#<key>` で叩くべき", async () => {
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow()] });
    ddbSend.mockResolvedValueOnce({ Attributes: { score: 100 } });
    await submitFlag(shared, flagScoring, "MYKEY", "Hello from tc-hello-world-alpha");
    const queryCmd = ddbSend.mock.calls[0]?.[0] as QueryCommand;
    expect(queryCmd).toBeInstanceOf(QueryCommand);
    expect(queryCmd.input.IndexName).toBe("GSI2");
    expect(queryCmd.input.ExpressionAttributeValues).toEqual({ ":pk": "TEAMKEY#MYKEY" });
  });
});
