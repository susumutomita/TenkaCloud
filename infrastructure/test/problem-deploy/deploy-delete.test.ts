import { PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestTeardown } from "../../lib/problem-deploy/handlers/deploy-handler/delete";
import type { DeploySharedResources } from "../../lib/problem-deploy/handlers/deploy-handler/deploy";

const NOW_MS = 1_700_000_000_000;

function buildShared(): {
  shared: DeploySharedResources;
  ddbSend: ReturnType<typeof vi.fn>;
  eventsSend: ReturnType<typeof vi.fn>;
} {
  const ddbSend = vi.fn();
  const eventsSend = vi.fn();
  const shared: DeploySharedResources = {
    tableName: "TestDeployments",
    eventBusName: "test-bus",
    ddb: { send: ddbSend } as unknown as DeploySharedResources["ddb"],
    events: { send: eventsSend } as unknown as DeploySharedResources["events"],
    problemsCatalog: {},
  };
  return { shared, ddbSend, eventsSend };
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
  status: "COMPLETE",
  expiresAt: 9_999_999_999,
  ...over,
});

describe("requestTeardown", () => {
  beforeEach(() => vi.clearAllMocks());

  it("正常系: status を DELETING に書き換えて DeployDeleteRequested を publish するべき", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleRow() });
    ddbSend.mockResolvedValueOnce({});
    eventsSend.mockResolvedValueOnce({});

    const out = await requestTeardown(shared, "tenant-acme", "JOB1", NOW_MS);
    expect(out).toEqual({ kind: "accepted", previousStatus: "COMPLETE" });

    const updateCmd = ddbSend.mock.calls[1]?.[0] as UpdateCommand;
    expect(updateCmd).toBeInstanceOf(UpdateCommand);
    expect(updateCmd.input.ExpressionAttributeValues?.[":deleting"]).toBe("DELETING");
    expect(updateCmd.input.ConditionExpression).toContain("tenantId = :tenantId");
    expect(updateCmd.input.ConditionExpression).toContain(":p");
    expect(updateCmd.input.ConditionExpression).toContain(":i");
    expect(updateCmd.input.ConditionExpression).toContain(":c");
    expect(updateCmd.input.ConditionExpression).toContain(":f");

    const putCmd = eventsSend.mock.calls[0]?.[0] as PutEventsCommand;
    expect(putCmd).toBeInstanceOf(PutEventsCommand);
    const entry = putCmd.input.Entries?.[0];
    expect(entry?.DetailType).toBe("DeployDeleteRequested");
    expect(entry?.Source).toBe("tenkacloud.deploy");
    expect(entry?.EventBusName).toBe("test-bus");
    const detail = JSON.parse(entry?.Detail ?? "{}");
    expect(detail).toMatchObject({
      jobId: "JOB1",
      tenantId: "tenant-acme",
      stackName: "tc-p-t",
      region: "ap-northeast-1",
      awsAccountId: "999999999999",
    });
  });

  it("stackId (ARN) があれば stackName よりそちらを使うべき", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Item: sampleRow({
        stackId: "arn:aws:cloudformation:ap-northeast-1:999999999999:stack/tc-p-t/abc-123",
      }),
    });
    ddbSend.mockResolvedValueOnce({});
    eventsSend.mockResolvedValueOnce({});

    await requestTeardown(shared, "tenant-acme", "JOB1", NOW_MS);

    const detail = JSON.parse(
      (eventsSend.mock.calls[0]?.[0] as PutEventsCommand).input.Entries?.[0]?.Detail ?? "{}",
    );
    expect(detail.stackName).toBe(
      "arn:aws:cloudformation:ap-northeast-1:999999999999:stack/tc-p-t/abc-123",
    );
  });

  it("行が無ければ not_found を返し Update / PutEvents を呼ばないべき", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: undefined });

    const out = await requestTeardown(shared, "tenant-acme", "JOB1", NOW_MS);
    expect(out).toEqual({ kind: "not_found" });
    expect(ddbSend.mock.calls.filter((c) => c[0] instanceof UpdateCommand)).toHaveLength(0);
    expect(eventsSend).not.toHaveBeenCalled();
  });

  it("tenantId 不一致は not_found 扱いで存在を漏らさないべき", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleRow({ tenantId: "tenant-other" }) });

    const out = await requestTeardown(shared, "tenant-acme", "JOB1", NOW_MS);
    expect(out).toEqual({ kind: "not_found" });
    expect(eventsSend).not.toHaveBeenCalled();
  });

  it("既に DELETING / DELETED なら already_deleted を返すべき (no-op)", async () => {
    for (const status of ["DELETING", "DELETED"]) {
      const { shared, ddbSend, eventsSend } = buildShared();
      ddbSend.mockResolvedValueOnce({ Item: sampleRow({ status }) });

      const out = await requestTeardown(shared, "tenant-acme", "JOB1", NOW_MS);
      expect(out).toEqual({ kind: "already_deleted" });
      expect(ddbSend.mock.calls.filter((c) => c[0] instanceof UpdateCommand)).toHaveLength(0);
      expect(eventsSend).not.toHaveBeenCalled();
    }
  });

  it("ConditionalCheckFailed は race として返すべき (並行 update に負けたケース)", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
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
    expect(eventsSend).not.toHaveBeenCalled();
  });

  it("region / awsAccountId / stackName が欠けていれば race として返し PutEvents しないべき", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Item: sampleRow({ region: "", namePrefix: "", stackId: undefined }),
    });

    const out = await requestTeardown(shared, "tenant-acme", "JOB1", NOW_MS);
    expect(out).toEqual({ kind: "race", reason: "tenant_or_status_mismatch" });
    expect(ddbSend.mock.calls.filter((c) => c[0] instanceof UpdateCommand)).toHaveLength(0);
    expect(eventsSend).not.toHaveBeenCalled();
  });

  it("最初の GetItem は PK=DEPLOYMENT#<jobId> SK=META を引くべき", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleRow({ jobId: "JOB42" }) });
    ddbSend.mockResolvedValueOnce({});
    eventsSend.mockResolvedValueOnce({});

    await requestTeardown(shared, "tenant-acme", "JOB42", NOW_MS);
    const getCmd = ddbSend.mock.calls[0]?.[0] as GetCommand;
    expect(getCmd).toBeInstanceOf(GetCommand);
    expect(getCmd.input.Key).toEqual({ PK: "DEPLOYMENT#JOB42", SK: "META" });
  });
});
