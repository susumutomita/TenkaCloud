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

  it("正常系 (1 deployment): Query → Update (ALL_NEW) で team scope view を返す (再 query 不要)", async () => {
    const { shared, ddbSend } = buildShared();
    // 1st Query: GSI2 で team の全 deployment 行
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow()] });
    // 2nd UpdateItem: ReturnValues=ALL_NEW で更新後 Attributes を返す
    ddbSend.mockResolvedValueOnce({
      Attributes: sampleRow({ displayTeamName: "新チーム" }),
    });

    const out = await setDisplayTeamName(shared, "KEY1", "新チーム");
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") {
      expect(out.view.team.teamName).toBe("新チーム");
      expect(out.view.team.teamNameSetByCompetitor).toBe(true);
      expect(out.view.problems).toHaveLength(1);
    }

    expect(ddbSend).toHaveBeenCalledTimes(2);
    const updateCmd = ddbSend.mock.calls[1]?.[0] as UpdateCommand;
    expect(updateCmd).toBeInstanceOf(UpdateCommand);
    expect(updateCmd.input.UpdateExpression).toContain("displayTeamName = :name");
    expect(updateCmd.input.ExpressionAttributeValues?.[":name"]).toBe("新チーム");
    expect(updateCmd.input.Key).toEqual({ PK: "DEPLOYMENT#JOB1", SK: "META" });
    expect(updateCmd.input.ReturnValues).toBe("ALL_NEW");
  });

  it("正常系 (N deployments): team の全 editable 行を Promise.all で並列 update するべき", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Items: [
        sampleRow({ jobId: "JOB1", PK: "DEPLOYMENT#JOB1" }),
        sampleRow({ jobId: "JOB2", PK: "DEPLOYMENT#JOB2", problemId: "p2" }),
        sampleRow({ jobId: "JOB3", PK: "DEPLOYMENT#JOB3", problemId: "p3", status: "DELETING" }),
      ],
    });
    // 並列 Update × 2 (DELETING 行は skip)。ALL_NEW で各 Attributes を返す。
    ddbSend.mockResolvedValueOnce({
      Attributes: sampleRow({ jobId: "JOB1", PK: "DEPLOYMENT#JOB1", displayTeamName: "X" }),
    });
    ddbSend.mockResolvedValueOnce({
      Attributes: sampleRow({
        jobId: "JOB2",
        PK: "DEPLOYMENT#JOB2",
        problemId: "p2",
        displayTeamName: "X",
      }),
    });

    await setDisplayTeamName(shared, "KEY1", "X");
    const updateCmds = ddbSend.mock.calls
      .map((c) => c[0])
      .filter((c): c is UpdateCommand => c instanceof UpdateCommand);
    expect(updateCmds).toHaveLength(2); // DELETING は skip
    const updatedKeys = updateCmds.map((c) => (c.input.Key as { PK: string }).PK).sort();
    expect(updatedKeys).toEqual(["DEPLOYMENT#JOB1", "DEPLOYMENT#JOB2"]);
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

  it("team の全行が DELETING / DELETED なら unauthorized (UpdateItem しない)", async () => {
    for (const status of ["DELETING", "DELETED"]) {
      const { shared, ddbSend } = buildShared();
      ddbSend.mockResolvedValueOnce({ Items: [sampleRow({ status })] });
      const out = await setDisplayTeamName(shared, "KEY1", "Alpha");
      expect(out.kind).toBe("unauthorized");
      const updateCalls = ddbSend.mock.calls.filter((c) => c[0] instanceof UpdateCommand);
      expect(updateCalls).toHaveLength(0);
    }
  });

  it("最初の Query は GSI2 KeyCondition (Limit なし、team の全行を取る)", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [sampleRow()] });
    ddbSend.mockResolvedValueOnce({
      Attributes: sampleRow({ displayTeamName: "X" }),
    });
    await setDisplayTeamName(shared, "KEY1", "X");
    const queryCmd = ddbSend.mock.calls[0]?.[0] as QueryCommand;
    expect(queryCmd).toBeInstanceOf(QueryCommand);
    expect(queryCmd.input.IndexName).toBe("GSI2");
    expect(queryCmd.input.Limit).toBeUndefined();
  });
});
