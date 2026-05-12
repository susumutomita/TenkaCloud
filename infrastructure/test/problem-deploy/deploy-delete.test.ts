import { PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestTeardown } from "../../lib/problem-deploy/handlers/deploy-handler/delete";
import type { DeploySharedResources } from "../../lib/problem-deploy/handlers/deploy-handler/deploy";

const NOW_MS = 1_700_000_000_000;

/**
 * Phase 2.2 (Issue #459): requestTeardown は CompetitorAccounts table も Get するため、
 * GetCommand を TableName で振り分けて mock する。verified 行は default で常に存在 (=
 * 旧 deploy 行を delete する際に「verified=true 行が無い」状態を pin したいときだけ
 * `unverified` option を渡す)。
 */
function buildShared(options: { unverified?: boolean } = {}): {
  shared: DeploySharedResources;
  ddbSend: ReturnType<typeof vi.fn>;
  eventsSend: ReturnType<typeof vi.fn>;
} {
  const ddbSend = vi.fn();
  const eventsSend = vi.fn();
  const wrappedSend = vi.fn(async (cmd: unknown) => {
    if (cmd instanceof GetCommand && cmd.input.TableName === "TestCompetitorAccounts") {
      if (options.unverified) return { Item: undefined };
      const sk = String(cmd.input.Key?.SK ?? "");
      const awsAccountId = sk.replace(/^ACCOUNT#/, "");
      return {
        Item: {
          PK: cmd.input.Key?.PK,
          SK: cmd.input.Key?.SK,
          awsAccountId,
          region: "ap-northeast-1",
          competitorRoleName: "TenkaCloud-CompetitorDeploy-Role",
          verified: true,
        },
      };
    }
    return ddbSend(cmd);
  });
  const shared: DeploySharedResources = {
    tableName: "TestDeployments",
    competitorAccountsTableName: "TestCompetitorAccounts",
    env: "development",
    eventBusName: "test-bus",
    ddb: { send: wrappedSend } as unknown as DeploySharedResources["ddb"],
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

  it("stackId (ARN) があれば namePrefix ではなく ARN を stackName として publish するべき", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Item: sampleRow({
        stackId: "arn:aws:cloudformation:ap-northeast-1:999999999999:stack/tc-p-t/abc-123",
      }),
    });
    ddbSend.mockResolvedValueOnce({});
    eventsSend.mockResolvedValueOnce({});

    await requestTeardown(shared, "tenant-acme", "JOB1", NOW_MS);

    // CFn DeleteStack は ARN も name も受け付けるが、削除済みと同名の new stack が
    // 並んだ場合に ARN なら必ず本来の物理リソースを差せるので priority を持たせる。
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

  it("region / awsAccountId / stackName が欠けていれば missing_required_fields を欠損 fields 付きで返すべき", async () => {
    // race (= 並行 update に負けた) と区別する: corruption (DDB データ欠損) は
    // operator が watch する別の運用シグナルなので別 reason として返す。
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Item: sampleRow({
        region: "",
        awsAccountId: "",
        namePrefix: "",
        stackId: undefined,
      }),
    });

    const out = await requestTeardown(shared, "tenant-acme", "JOB1", NOW_MS);
    expect(out).toEqual({
      kind: "missing_required_fields",
      fields: ["region", "awsAccountId", "stackName"],
    });
    expect(ddbSend.mock.calls.filter((c) => c[0] instanceof UpdateCommand)).toHaveLength(0);
    expect(eventsSend).not.toHaveBeenCalled();
  });

  it("publishProblemEvent が失敗したら status を FAILED に compensating update して例外を伝播するべき", async () => {
    // DELETING のまま放置すると、次の呼び出しが already_deleted で no-op を返し
    // CFn stack が orphan 化するため、publish 失敗時は status を巻き戻す。
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleRow() });
    ddbSend.mockResolvedValueOnce({}); // DELETING 書き込み成功
    eventsSend.mockRejectedValueOnce(new Error("EventBridge throttled"));
    ddbSend.mockResolvedValueOnce({}); // FAILED への巻き戻し成功

    await expect(requestTeardown(shared, "tenant-acme", "JOB1", NOW_MS)).rejects.toThrow(
      /EventBridge throttled/,
    );

    const updateCmds = ddbSend.mock.calls
      .map((c) => c[0])
      .filter((c): c is UpdateCommand => c instanceof UpdateCommand);
    expect(updateCmds).toHaveLength(2);
    // 2 件目 (compensation) が FAILED への巻き戻し
    const compensation = updateCmds[1] as UpdateCommand;
    expect(compensation.input.ExpressionAttributeValues?.[":failed"]).toBe("FAILED");
    expect(compensation.input.ExpressionAttributeValues?.[":deleting"]).toBe("DELETING");
    expect(compensation.input.ConditionExpression).toContain("#s = :deleting");
    expect(compensation.input.ExpressionAttributeValues?.[":reason"]).toContain(
      "Failed to publish",
    );
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
