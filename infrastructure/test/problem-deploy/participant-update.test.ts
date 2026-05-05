import { QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ParticipantSharedResources } from "../../lib/problem-deploy/handlers/participant-handler/shared";
import {
  setDisplayTeamName,
  validateTeamName,
} from "../../lib/problem-deploy/handlers/participant-handler/update";

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
  problemId: "p",
  tenantId: "tenant-acme",
  awsAccountId: "999999999999",
  region: "ap-northeast-1",
  teamName: "operator-slug",
  namePrefix: "tc-p-operator-slug",
  status: "IN_PROGRESS",
  expiresAt: 9_999_999_999,
  ...over,
});

describe("validateTeamName", () => {
  it("英数字 / スペース / _ / - は OK", () => {
    expect(validateTeamName("Alpha-Team_1")).toBe("Alpha-Team_1");
    expect(validateTeamName("Team 1")).toBe("Team 1");
  });

  it("ひらがな / カタカナ / 漢字 OK", () => {
    expect(validateTeamName("わたしたちのチーム")).toBe("わたしたちのチーム");
    expect(validateTeamName("超強い隊")).toBe("超強い隊");
  });

  it("trim される", () => {
    expect(validateTeamName("  hello  ")).toBe("hello");
  });

  it("空 / 空白のみ / 41 文字以上は undefined", () => {
    expect(validateTeamName("")).toBeUndefined();
    expect(validateTeamName("   ")).toBeUndefined();
    expect(validateTeamName("a".repeat(41))).toBeUndefined();
  });

  it("制御文字 / 改行 / emoji は拒否", () => {
    expect(validateTeamName("hello\nworld")).toBeUndefined();
    expect(validateTeamName("\u0000abc")).toBeUndefined();
    expect(validateTeamName("team 🚀")).toBeUndefined();
  });

  it("string でない値は undefined", () => {
    expect(validateTeamName(undefined)).toBeUndefined();
    expect(validateTeamName(null)).toBeUndefined();
    expect(validateTeamName(42)).toBeUndefined();
    expect(validateTeamName({ teamName: "x" })).toBeUndefined();
  });
});

describe("setDisplayTeamName", () => {
  beforeEach(() => vi.clearAllMocks());

  it("正常系: GSI2 Query → UpdateItem (ReturnValues=ALL_NEW) で 2 round-trip", async () => {
    const { shared, ddbSend } = buildShared();
    // 1st Query: 現在の行を取得
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow()] });
    // 2nd UpdateItem: ALL_NEW で更新後の行を返す
    ddbSend.mockResolvedValueOnce({
      Attributes: sampleRow({ displayTeamName: "新チーム" }),
    });

    const out = await setDisplayTeamName(shared, "KEY1", "新チーム");
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") {
      expect(out.view.teamName).toBe("新チーム");
      expect(out.view.teamNameSetByCompetitor).toBe(true);
    }

    // ちょうど 2 回 (Query + UpdateItem)。3 回目の再 Query が消えていることの担保。
    expect(ddbSend).toHaveBeenCalledTimes(2);

    const updateCmd = ddbSend.mock.calls[1]?.[0] as UpdateCommand;
    expect(updateCmd).toBeInstanceOf(UpdateCommand);
    expect(updateCmd.input.UpdateExpression).toContain("displayTeamName = :name");
    expect(updateCmd.input.ExpressionAttributeValues?.[":name"]).toBe("新チーム");
    expect(updateCmd.input.Key).toEqual({ PK: "DEPLOYMENT#JOB1", SK: "META" });
    expect(updateCmd.input.ReturnValues).toBe("ALL_NEW");
  });

  it("無効な teamName は invalid_team_name (DDB を叩かない)", async () => {
    const { shared, ddbSend } = buildShared();
    const out = await setDisplayTeamName(shared, "KEY1", "");
    expect(out.kind).toBe("invalid_team_name");
    expect(ddbSend).not.toHaveBeenCalled();
  });

  it("該当行が無ければ unauthorized", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [] });
    const out = await setDisplayTeamName(shared, "NOSUCHKEY", "Alpha");
    expect(out.kind).toBe("unauthorized");
  });

  it("status が DELETING / DELETED なら unauthorized (UpdateItem しない)", async () => {
    for (const status of ["DELETING", "DELETED"]) {
      const { shared, ddbSend } = buildShared();
      ddbSend.mockResolvedValueOnce({ Items: [sampleRow({ status })] });
      const out = await setDisplayTeamName(shared, "KEY1", "Alpha");
      expect(out.kind).toBe("unauthorized");
      const updateCalls = ddbSend.mock.calls.filter((c) => c[0] instanceof UpdateCommand);
      expect(updateCalls).toHaveLength(0);
    }
  });

  it("最初の Query は GSI2 KeyCondition + Limit=1", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow()] });
    ddbSend.mockResolvedValueOnce({ Attributes: sampleRow({ displayTeamName: "X" }) });
    await setDisplayTeamName(shared, "KEY1", "X");
    const queryCmd = ddbSend.mock.calls[0]?.[0] as QueryCommand;
    expect(queryCmd).toBeInstanceOf(QueryCommand);
    expect(queryCmd.input.IndexName).toBe("GSI2");
    expect(queryCmd.input.Limit).toBe(1);
  });
});
