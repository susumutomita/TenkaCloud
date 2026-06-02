import { PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("normal case: should rewrite status to DELETING and publish DeployDeleteRequested", async () => {
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

  it("should publish the ARN as stackName instead of namePrefix when stackId (ARN) is present", async () => {
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

  it("should return not_found without calling Update / PutEvents when the row is missing", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: undefined });

    const out = await requestTeardown(shared, "tenant-acme", "JOB1", NOW_MS);
    expect(out).toEqual({ kind: "not_found" });
    expect(ddbSend.mock.calls.filter((c) => c[0] instanceof UpdateCommand)).toHaveLength(0);
    expect(eventsSend).not.toHaveBeenCalled();
  });

  it("should treat tenantId mismatch as not_found and not leak existence", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleRow({ tenantId: "tenant-other" }) });

    const out = await requestTeardown(shared, "tenant-acme", "JOB1", NOW_MS);
    expect(out).toEqual({ kind: "not_found" });
    expect(eventsSend).not.toHaveBeenCalled();
  });

  it("should return already_deleted when already DELETING / DELETED (no-op)", async () => {
    for (const status of ["DELETING", "DELETED"]) {
      const { shared, ddbSend, eventsSend } = buildShared();
      ddbSend.mockResolvedValueOnce({ Item: sampleRow({ status }) });

      const out = await requestTeardown(shared, "tenant-acme", "JOB1", NOW_MS);
      expect(out).toEqual({ kind: "already_deleted" });
      expect(ddbSend.mock.calls.filter((c) => c[0] instanceof UpdateCommand)).toHaveLength(0);
      expect(eventsSend).not.toHaveBeenCalled();
    }
  });

  it("should return race on ConditionalCheckFailed (lost concurrent update)", async () => {
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

  it("should return missing_required_fields with the missing fields when region / awsAccountId / stackName are absent", async () => {
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

  it("should compensating-update status to FAILED and propagate the exception when publishProblemEvent fails", async () => {
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

  it("the first GetItem should hit PK=DEPLOYMENT#<jobId> SK=META", async () => {
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

/**
 * [ADR-026/027/032 / #1410-1412] 非 AWS runtime (sakura/apprun) の teardown は CFn DeleteStack event を
 * publish せず adapter.destroy (cloud REST) で削除する。 status は DELETING に倒し、 EventBridge は使わない。
 */
describe("requestTeardown (non-AWS runtime via adapter)", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  function buildSakuraShared(): {
    shared: DeploySharedResources;
    ddbSend: ReturnType<typeof vi.fn>;
    eventsSend: ReturnType<typeof vi.fn>;
    ssmSend: ReturnType<typeof vi.fn>;
  } {
    const ddbSend = vi.fn();
    const eventsSend = vi.fn();
    const ssmSend = vi.fn(async () => ({
      Parameter: { Value: JSON.stringify({ accessToken: "tok", accessTokenSecret: "sec" }) },
    }));
    const shared = {
      tableName: "TestDeployments",
      competitorAccountsTableName: "TestCompetitorAccounts",
      env: "development",
      eventBusName: "test-bus",
      ddb: { send: ddbSend } as unknown as DeploySharedResources["ddb"],
      events: { send: eventsSend } as unknown as DeploySharedResources["events"],
      problemsCatalog: {},
      ssm: { send: ssmSend },
    } as unknown as DeploySharedResources;
    return { shared, ddbSend, eventsSend, ssmSend };
  }

  const sakuraRow = (over: Record<string, unknown> = {}) => ({
    ...sampleRow(),
    runtimeProvider: "sakura",
    runtimeEngine: "apprun",
    runtimeEntry: "registry/img:1",
    ...over,
  });

  it("should transition DELETING + call adapter.destroy (AppRun REST) without publishing a CFn delete event", async () => {
    const { shared, ddbSend, eventsSend, ssmSend } = buildSakuraShared();
    ddbSend.mockResolvedValueOnce({ Item: sakuraRow() }); // Get row
    ddbSend.mockResolvedValueOnce({}); // transition → DELETING
    // AppRun REST: findByName (list) → delete by id
    const appRunFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: "a1", name: "tc-p-t" }] }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", appRunFetch);

    const res = await requestTeardown(shared, "tenant-acme", "JOB1", NOW_MS);
    expect(res).toEqual({ kind: "accepted", previousStatus: "COMPLETE" });
    // DELETING transition は走る
    expect(ddbSend.mock.calls.some((c) => c[0] instanceof UpdateCommand)).toBe(true);
    // CFn delete event は publish しない
    expect(eventsSend).not.toHaveBeenCalled();
    // SSM から鍵を引き AppRun REST を叩いた (list + DELETE)
    expect(ssmSend).toHaveBeenCalled();
    expect(appRunFetch.mock.calls[1][1].method).toBe("DELETE");
  });

  it("should compensate to FAILED when adapter.destroy throws", async () => {
    const { shared, ddbSend, eventsSend } = buildSakuraShared();
    ddbSend.mockResolvedValueOnce({ Item: sakuraRow() }); // Get
    ddbSend.mockResolvedValueOnce({}); // DELETING
    ddbSend.mockResolvedValueOnce({}); // compensation → FAILED
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(new Response("boom", { status: 500 })), // list 失敗
    );
    await expect(requestTeardown(shared, "tenant-acme", "JOB1", NOW_MS)).rejects.toThrow();
    expect(eventsSend).not.toHaveBeenCalled();
    // 補償 Update (DELETING → FAILED) が走った (= orphan 防止)
    const updates = ddbSend.mock.calls.filter((c) => c[0] instanceof UpdateCommand);
    expect(updates.length).toBeGreaterThanOrEqual(2);
  });
});
