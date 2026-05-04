import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestTeardown } from "../../lib/problem-deploy/handlers/deploy-handler/delete";
import type { DeploySharedResources } from "../../lib/problem-deploy/handlers/deploy-handler/deploy";

const NOW_MS = 1_700_000_000_000;

function buildShared(): {
  shared: DeploySharedResources;
  ddbSend: ReturnType<typeof vi.fn>;
} {
  const ddbSend = vi.fn();
  const shared: DeploySharedResources = {
    tableName: "TestDeployments",
    eventBusName: "test-bus",
    ddb: { send: ddbSend } as unknown as DeploySharedResources["ddb"],
    events: {} as unknown as DeploySharedResources["events"],
  };
  return { shared, ddbSend };
}

const sampleRow = (over: Record<string, unknown> = {}) => ({
  PK: "DEPLOYMENT#JOB1",
  SK: "META",
  jobId: "JOB1",
  tenantId: "tenant-acme",
  problemId: "p",
  awsAccountId: "999999999999",
  region: "ap-northeast-1",
  teamName: "T",
  namePrefix: "tc-p-t",
  status: "IN_PROGRESS",
  expiresAt: 9_999_999_999,
  ...over,
});

describe("requestTeardown", () => {
  beforeEach(() => vi.clearAllMocks());

  it("正常系: expiresAt を now() に書き換えて accepted を返すべき", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleRow() });
    ddbSend.mockResolvedValueOnce({});

    const out = await requestTeardown(shared, "tenant-acme", "JOB1", NOW_MS);
    expect(out).toEqual({ kind: "accepted", previousStatus: "IN_PROGRESS" });

    const updateCmd = ddbSend.mock.calls[1]?.[0] as UpdateCommand;
    expect(updateCmd).toBeInstanceOf(UpdateCommand);
    expect(updateCmd.input.ExpressionAttributeValues?.[":expiresAt"]).toBe(
      Math.floor(NOW_MS / 1000),
    );
    expect(updateCmd.input.ConditionExpression).toContain("tenantId = :tenantId");
    expect(updateCmd.input.ConditionExpression).toContain(":p");
    expect(updateCmd.input.ConditionExpression).toContain(":i");
    expect(updateCmd.input.ConditionExpression).toContain(":c");
    expect(updateCmd.input.ConditionExpression).toContain(":f");
  });

  it("行が無ければ not_found を返し Update を呼ばないべき", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: undefined });

    const out = await requestTeardown(shared, "tenant-acme", "JOB1", NOW_MS);
    expect(out).toEqual({ kind: "not_found" });
    const updateCalls = ddbSend.mock.calls.filter((c) => c[0] instanceof UpdateCommand);
    expect(updateCalls).toHaveLength(0);
  });

  it("tenantId 不一致は not_found 扱いで存在を漏らさないべき", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleRow({ tenantId: "tenant-other" }) });

    const out = await requestTeardown(shared, "tenant-acme", "JOB1", NOW_MS);
    expect(out).toEqual({ kind: "not_found" });
  });

  it("既に DELETING / DELETED なら already_deleted を返すべき (no-op)", async () => {
    for (const status of ["DELETING", "DELETED"]) {
      const { shared, ddbSend } = buildShared();
      ddbSend.mockResolvedValueOnce({ Item: sampleRow({ status }) });

      const out = await requestTeardown(shared, "tenant-acme", "JOB1", NOW_MS);
      expect(out).toEqual({ kind: "already_deleted" });
      const updateCalls = ddbSend.mock.calls.filter((c) => c[0] instanceof UpdateCommand);
      expect(updateCalls).toHaveLength(0);
    }
  });

  it("ConditionalCheckFailed は race として返すべき (StatusUpdater が先に状態を変えたケース)", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleRow() });
    ddbSend.mockImplementationOnce(async (cmd) => {
      if (cmd instanceof UpdateCommand) {
        const err: Error & { name?: string } = new Error("conditional check failed");
        err.name = "ConditionalCheckFailedException";
        throw err;
      }
      return {};
    });

    const out = await requestTeardown(shared, "tenant-acme", "JOB1", NOW_MS);
    expect(out).toEqual({ kind: "race", reason: "tenant_or_status_mismatch" });
  });

  it("Update が他のエラーを投げたら例外を伝播するべき", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleRow() });
    ddbSend.mockRejectedValueOnce(new Error("ProvisionedThroughputExceeded"));

    await expect(requestTeardown(shared, "tenant-acme", "JOB1", NOW_MS)).rejects.toThrow(
      /ProvisionedThroughputExceeded/,
    );
  });

  it("最初の GetItem は PK=DEPLOYMENT#<jobId> SK=META を引くべき", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleRow() });
    ddbSend.mockResolvedValueOnce({});

    await requestTeardown(shared, "tenant-acme", "JOB42", NOW_MS);
    const getCmd = ddbSend.mock.calls[0]?.[0] as GetCommand;
    expect(getCmd).toBeInstanceOf(GetCommand);
    expect(getCmd.input.Key).toEqual({ PK: "DEPLOYMENT#JOB42", SK: "META" });
  });
});
