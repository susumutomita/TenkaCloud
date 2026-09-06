import { PutEventsCommand } from "@aws-sdk/client-eventbridge";
import {
  DeleteCommand,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestTeardown } from "../../lib/problem-deploy/handlers/deploy-handler/delete";
import type { DeploySharedResources } from "../../lib/problem-deploy/handlers/deploy-handler/deploy";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers";

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
    runtime: makeTestControlDataRuntime(),
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
      (eventsSend.mock.calls[0] as [PutEventsCommand])[0].input.Entries?.[0]?.Detail ?? "{}",
    );
    expect(detail.stackName).toBe(
      "arn:aws:cloudformation:ap-northeast-1:999999999999:stack/tc-p-t/abc-123",
    );
  });

  it("#1810: should fall back to namePrefix for stackName when stackId is an empty string (FAILED deploy)", async () => {
    // 失敗 deployment は stack ARN 記録前に終わると stackId="" (空文字)。旧コードの
    // `stackId ?? namePrefix` は空文字を fallback できず stackName="" → missing_required_fields
    // で失敗 deployment の手動削除すら不能だった。namePrefix で teardown できること。
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleRow({ status: "FAILED", stackId: "" }) });
    ddbSend.mockResolvedValueOnce({});
    eventsSend.mockResolvedValueOnce({});

    const out = await requestTeardown(shared, "tenant-acme", "JOB1", NOW_MS);
    expect(out.kind).toBe("accepted");
    const detail = JSON.parse(
      (eventsSend.mock.calls[0] as [PutEventsCommand])[0].input.Entries?.[0]?.Detail ?? "{}",
    );
    expect(detail.stackName).toBe("tc-p-t"); // = sampleRow namePrefix
  });

  it("Issue #2019: should tear down an APPROVAL_PENDING (held) deploy instead of returning a conflict", async () => {
    // A held deploy has no live stack, but the operator must still be able to
    // reject/clean it up. The teardown condition must accept APPROVAL_PENDING.
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Item: sampleRow({ status: "APPROVAL_PENDING", stackId: "" }),
    });
    ddbSend.mockResolvedValueOnce({});
    eventsSend.mockResolvedValueOnce({});

    const out = await requestTeardown(shared, "tenant-acme", "JOB1", NOW_MS);
    expect(out).toEqual({ kind: "accepted", previousStatus: "APPROVAL_PENDING" });

    const updateCmd = ddbSend.mock.calls[1]?.[0] as UpdateCommand;
    expect(updateCmd.input.ExpressionAttributeValues?.[":ap"]).toBe("APPROVAL_PENDING");
    expect(updateCmd.input.ConditionExpression).toContain(":ap");
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
 * [#1410-1412 regression guard] #1659 が非 AWS teardown を adapter.destroy に分岐させた際、
 * **AWS/CFn 行 (= runtimeProvider/Engine/Entry が無い行、 bulk-deploy が永続化する shape)** が
 * 誤って adapter 経路へ落ちると `AwsCloudFormationRuntimeAdapter.destroy` が
 * `AdapterMethodNotWiredError` を投げ、 CFn DeleteStack event が publish されず stack が
 * CREATE_COMPLETE のまま orphan 化する。 Lite mode (same-account, stacks `tc-*-team-N`) の
 * event teardown はこの行 shape に乗るため、 「runtime field の無い AWS 行は必ず EventBridge CFn 経路」
 * を invariant として固定する。
 */
describe("requestTeardown (AWS/CFn row stays on the DeleteStack EventBridge path)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should publish a CFn DeployDeleteRequested (DeleteStack) for an AWS row without runtime fields, not adapter.destroy", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    // bulk-deploy が永続化する AWS 行 shape: runtimeProvider/Engine/Entry は **存在しない**。
    const item = sampleRow({
      problemId: "hello-world-battle",
      namePrefix: "tc-hello-world-battle-team-1",
      stackId:
        "arn:aws:cloudformation:ap-northeast-1:999999999999:stack/tc-hello-world-battle-team-1/abc",
    });
    expect(item).not.toHaveProperty("runtimeProvider");
    ddbSend.mockResolvedValueOnce({ Item: item }); // Get
    ddbSend.mockResolvedValueOnce({}); // transition → DELETING
    eventsSend.mockResolvedValueOnce({}); // PutEvents (DeployDeleteRequested)

    const out = await requestTeardown(shared, "tenant-acme", "JOB1", NOW_MS);
    // adapter.destroy 経路なら AdapterMethodNotWiredError で reject していたはず。
    expect(out).toEqual({ kind: "accepted", previousStatus: "COMPLETE" });

    // EventBridge に CFn DeleteStack 要求 (= State Machine → delete-battles.sh) が出る。
    const putCmd = eventsSend.mock.calls[0]?.[0] as PutEventsCommand;
    expect(putCmd).toBeInstanceOf(PutEventsCommand);
    expect(putCmd.input.Entries?.[0]?.DetailType).toBe("DeployDeleteRequested");
    const detail = JSON.parse(putCmd.input.Entries?.[0]?.Detail ?? "{}");
    expect(detail.stackName).toBe(
      "arn:aws:cloudformation:ap-northeast-1:999999999999:stack/tc-hello-world-battle-team-1/abc",
    );
  });

  it("should keep an explicit aws/cloudformation row (runtime fields present) on the CFn DeleteStack path", async () => {
    // 明示 runtime: aws/cloudformation を宣言した問題行も EXECUTABLE_PROVIDER/ENGINE 一致なので
    // CFn 経路を維持する (= adapter.destroy の AdapterMethodNotWiredError を踏まない)。
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Item: sampleRow({
        runtimeProvider: "aws",
        runtimeEngine: "cloudformation",
        runtimeEntry: "template.yaml",
      }),
    });
    ddbSend.mockResolvedValueOnce({});
    eventsSend.mockResolvedValueOnce({});

    const out = await requestTeardown(shared, "tenant-acme", "JOB1", NOW_MS);
    expect(out).toEqual({ kind: "accepted", previousStatus: "COMPLETE" });
    expect(eventsSend).toHaveBeenCalledOnce();
    const detail = JSON.parse(
      (eventsSend.mock.calls[0] as [PutEventsCommand])[0].input.Entries?.[0]?.Detail ?? "{}",
    );
    expect(detail.stackName).toBe("tc-p-t");
  });
});

/**
 * [#1410-1412] 非 AWS runtime (sakura/apprun) の teardown は CFn DeleteStack event を
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
      runtime: makeTestControlDataRuntime(),
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

/**
 * [Issue #3149] Teardown of the last deployment on a problem is what removes
 * that problem's coordination state while the event keeps running.
 *
 * The decision itself is pinned against a real database in
 * `coordination-cleanup.test.ts`. What is asserted here is the wiring: that the
 * teardown path reaches it at all, that it does so only for rows that have a
 * coordination namespace, and that a failure there cannot fail a teardown that
 * has already been accepted.
 */
describe("requestTeardown coordination cleanup (#3149)", () => {
  beforeEach(() => vi.clearAllMocks());

  const eventRow = (over: Record<string, unknown> = {}) =>
    sampleRow({ eventId: "ev-1", teamId: "team-a", problemId: "crypto-battle", ...over });

  it("should look for this problem's coordination state after marking the row DELETING", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: eventRow() });
    ddbSend.mockResolvedValueOnce({}); // markDeleting
    ddbSend.mockResolvedValueOnce({ Item: undefined }); // run pointer: never reset
    ddbSend.mockResolvedValueOnce({ Item: undefined }); // coordination state: absent
    eventsSend.mockResolvedValueOnce({});

    const out = await requestTeardown(shared, "tenant-acme", "JOB1", NOW_MS);

    expect(out).toEqual({ kind: "accepted", previousStatus: "COMPLETE" });
    const reads = ddbSend.mock.calls
      .map(([cmd]) => cmd)
      .filter((cmd): cmd is GetCommand => cmd instanceof GetCommand);
    expect(reads.some((cmd) => String(cmd.input.Key?.PK ?? "").startsWith("COORD#"))).toBe(true);
  });

  it("should delete the state conditionally once no deployment can act on the problem", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: eventRow() });
    ddbSend.mockResolvedValueOnce({}); // markDeleting
    // [Issue #3153] The run pointer comes first: cleanup has to act on the run
    // the problem is actually on. Absent means it was never reset.
    ddbSend.mockResolvedValueOnce({ Item: undefined });
    ddbSend.mockResolvedValueOnce({ Item: { state: { turn: 3 }, version: 4 } });
    // The event listing: the only row for this problem is the one just torn
    // down, so nothing can act on the state any more.
    ddbSend.mockResolvedValueOnce({
      Items: [{ ...eventRow(), teardownRequestedAt: "2026-07-02T00:00:00.000Z" }],
    });
    ddbSend.mockResolvedValue({});
    eventsSend.mockResolvedValueOnce({});

    await requestTeardown(shared, "tenant-acme", "JOB1", NOW_MS);

    const deletes = ddbSend.mock.calls
      .map(([cmd]) => cmd)
      .filter((cmd): cmd is DeleteCommand => cmd instanceof DeleteCommand);
    // The version guard and closure now precede deletion in one transaction.
    const commands = ddbSend.mock.calls.map(([cmd]) => cmd);
    const closure = commands.find(
      (cmd): cmd is TransactWriteCommand => cmd instanceof TransactWriteCommand,
    );
    expect(closure?.input.TransactItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ConditionCheck: expect.objectContaining({
            Key: { PK: "COORD#tenant-acme#ev-1#crypto-battle#default", SK: "STATE" },
            ConditionExpression:
              "attribute_not_exists(coordinationScoresPending) AND version = :version",
            ExpressionAttributeValues: { ":version": 4 },
          }),
        }),
        expect.objectContaining({
          Put: expect.objectContaining({ Item: expect.objectContaining({ closed: true }) }),
        }),
      ]),
    );
    expect(commands.indexOf(closure)).toBeLessThan(commands.indexOf(deletes[0]));
    expect(deletes[0]?.input.ConditionExpression).toBe(
      "attribute_not_exists(coordinationScoresPending)",
    );
  });

  it("should leave the state alone while another team is still deployed", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: eventRow() });
    ddbSend.mockResolvedValueOnce({}); // markDeleting
    ddbSend.mockResolvedValueOnce({ Item: undefined }); // run pointer: never reset
    ddbSend.mockResolvedValueOnce({ Item: { state: { turn: 3 }, version: 4 } });
    ddbSend.mockResolvedValueOnce({
      Items: [
        { ...eventRow(), teardownRequestedAt: "2026-07-02T00:00:00.000Z" },
        { ...eventRow(), jobId: "JOB2", teamId: "team-b" },
      ],
    });
    eventsSend.mockResolvedValueOnce({});

    await requestTeardown(shared, "tenant-acme", "JOB1", NOW_MS);

    // Coordination state is shared by every team on the problem. Wiping it
    // because one team left would end the match for the others.
    const deletes = ddbSend.mock.calls
      .map(([cmd]) => cmd)
      .filter((cmd) => cmd instanceof DeleteCommand);
    expect(deletes).toHaveLength(0);
    expect(ddbSend.mock.calls.map(([cmd]) => cmd).some((cmd) => cmd instanceof QueryCommand)).toBe(
      true,
    );
  });

  it("should not look for coordination state on a deployment that has no event", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    // The pre-event `POST /problems/:id/deploy` path. Such a row has no
    // coordination namespace, so a lookup would address rows that cannot exist.
    ddbSend.mockResolvedValueOnce({ Item: sampleRow() });
    ddbSend.mockResolvedValueOnce({});
    eventsSend.mockResolvedValueOnce({});

    await requestTeardown(shared, "tenant-acme", "JOB1", NOW_MS);

    const reads = ddbSend.mock.calls
      .map(([cmd]) => cmd)
      .filter((cmd): cmd is GetCommand => cmd instanceof GetCommand);
    expect(reads.some((cmd) => String(cmd.input.Key?.PK ?? "").startsWith("COORD#"))).toBe(false);
  });

  it("should report a non-Error cleanup failure without losing the reason", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    const trace = vi.spyOn(console, "log").mockImplementation(() => undefined);
    ddbSend.mockResolvedValueOnce({ Item: eventRow() });
    ddbSend.mockResolvedValueOnce({}); // markDeleting
    // An AWS SDK middleware or a plugin can reject with a plain value. Reading
    // `.message` off it would log `undefined` and lose the only clue an
    // operator has about why a namespace was left behind.
    ddbSend.mockRejectedValueOnce("control data unavailable");
    ddbSend.mockResolvedValue({});
    eventsSend.mockResolvedValueOnce({});

    const out = await requestTeardown(shared, "tenant-acme", "JOB1", NOW_MS);

    expect(out).toEqual({ kind: "accepted", previousStatus: "COMPLETE" });
    const logged = trace.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.includes("coordination.cleanup-failed"));
    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0] ?? "{}")).toMatchObject({
      event: "deploy.delete.coordination.cleanup-failed",
      reason: "control data unavailable",
    });
    trace.mockRestore();
  });

  it("should still accept the teardown when the cleanup itself fails", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: eventRow() });
    ddbSend.mockResolvedValueOnce({}); // markDeleting
    ddbSend.mockRejectedValueOnce(new Error("coordination read failed"));
    ddbSend.mockResolvedValue({});
    eventsSend.mockResolvedValueOnce({});

    // The stack deletion is already under way. Reporting failure here would
    // tell the operator a teardown did not happen when it did, and would hide a
    // leaked stack (money) behind a leaked row (bytes, with its own TTL).
    const out = await requestTeardown(shared, "tenant-acme", "JOB1", NOW_MS);
    expect(out).toEqual({ kind: "accepted", previousStatus: "COMPLETE" });
    expect(eventsSend).toHaveBeenCalled();
  });
});
