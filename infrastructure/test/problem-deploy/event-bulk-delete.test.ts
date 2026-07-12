import type { PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { GetCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bulkTeardownEvent } from "../../lib/problem-deploy/handlers/event-handler/bulk-delete";
import type { EventSharedResources } from "../../lib/problem-deploy/handlers/event-handler/shared";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers";

const NOW_MS = 1_700_000_000_000;

function buildShared(over: Partial<EventSharedResources> = {}): {
  shared: EventSharedResources;
  ddbSend: ReturnType<typeof vi.fn>;
  eventsSend: ReturnType<typeof vi.fn>;
} {
  const ddbSend = vi.fn();
  const eventsSend = vi.fn();
  const shared: EventSharedResources = {
    runtime: makeTestControlDataRuntime(),
    eventsTableName: "TestEvents",
    teamsTableName: "TestTeams",
    deploymentsTableName: "TestDeployments",
    competitorAccountsTableName: "TestCompetitorAccounts",
    eventBusName: "test-bus",
    env: "development",
    ddb: { send: ddbSend } as unknown as EventSharedResources["ddb"],
    events: { send: eventsSend } as unknown as EventSharedResources["events"],
    problemsCatalog: {},
    ...over,
  };
  return { shared, ddbSend, eventsSend };
}

const sampleEvent = (over: Record<string, unknown> = {}) => ({
  eventId: "EV1",
  tenantId: "tenant-acme",
  name: "Spring 2026",
  status: "DRAFT",
  ...over,
});

const dep = (over: Record<string, unknown> = {}) => ({
  jobId: "01HJOBONE",
  eventId: "EV1",
  tenantId: "tenant-acme",
  problemId: "p",
  awsAccountId: "999999999999",
  competitorRoleArn: "arn:aws:iam::999999999999:role/TenkaCloud-CompetitorDeploy-Role",
  externalIdParameterName: "/development/tenants/tenant-acme/external-id",
  region: "ap-northeast-1",
  namePrefix: "tc-p-team-1",
  status: "COMPLETE",
  ...over,
});

describe("bulkTeardownEvent", () => {
  beforeEach(() => vi.clearAllMocks());

  it("normal case: should Get(Event) confirm → filter deployment by eventId, parallel-update to DELETING, and publish DeployDeleteRequested", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() }); // Get(Event)
    ddbSend.mockResolvedValueOnce({
      // Query(Deployments) — server-side FilterExpression が EV1 のみ返す
      // (OTHER event は DDB が事前に除外、test mock は事後の状態を再現)
      Items: [
        dep({ jobId: "01A", namePrefix: "tc-p-t1" }),
        dep({ jobId: "01B", namePrefix: "tc-p-t2", eventId: "EV1" }),
      ],
    });
    ddbSend.mockResolvedValue({}); // 並列 Update * 2
    eventsSend.mockResolvedValue({}); // PutEvents 1 chunk

    const out = await bulkTeardownEvent(shared, "tenant-acme", "EV1", NOW_MS);
    expect(out).toEqual({
      kind: "ok",
      result: { eventId: "EV1", enqueued: 2, skipped: 0, failed: 0 },
    });

    // Query が FilterExpression で eventId 一致を要求し、cross-event 漏洩を防ぐ
    const queryCmds = ddbSend.mock.calls
      .map((c) => c[0])
      .filter((c): c is QueryCommand => c instanceof QueryCommand);
    expect(queryCmds[0]?.input.FilterExpression).toBe("eventId = :ev");
    expect(queryCmds[0]?.input.ExpressionAttributeValues?.[":ev"]).toBe("EV1");

    const updateCmds = ddbSend.mock.calls
      .map((c) => c[0])
      .filter((c): c is UpdateCommand => c instanceof UpdateCommand);
    // 2 deployment updates (DELETING) + 1 Event status update (TEARDOWN, #557)
    expect(updateCmds).toHaveLength(3);
    const depUpdates = updateCmds.filter(
      (c) => c.input.ExpressionAttributeValues?.[":deleting"] === "DELETING",
    );
    expect(depUpdates).toHaveLength(2);
    for (const cmd of depUpdates) {
      expect(cmd.input.ConditionExpression).toContain("tenantId = :tenantId");
    }
    // #557: Event status TEARDOWN への遷移を pin
    const eventStatusUpdate = updateCmds.find(
      (c) => c.input.ExpressionAttributeValues?.[":teardown"] === "TEARDOWN",
    );
    expect(eventStatusUpdate).toBeDefined();
    expect(eventStatusUpdate?.input.ConditionExpression).toContain("#status <> :archived");
    expect(eventStatusUpdate?.input.ExpressionAttributeValues?.[":tenantId"]).toBe("tenant-acme");

    const putCmd = eventsSend.mock.calls[0]?.[0] as PutEventsCommand;
    expect(putCmd.input.Entries).toHaveLength(2);
    expect(putCmd.input.Entries?.[0]?.DetailType).toBe("DeployDeleteRequested");
  });

  it("should return not_found without calling Deployments query when the event is absent", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: undefined });

    const out = await bulkTeardownEvent(shared, "tenant-acme", "EV1", NOW_MS);
    expect(out).toEqual({ kind: "not_found" });
    expect(ddbSend).toHaveBeenCalledTimes(1);
    expect(eventsSend).not.toHaveBeenCalled();
  });

  it("should return not_found on tenantId mismatch (cross-tenant leak guard)", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent({ tenantId: "tenant-other" }) });

    const out = await bulkTeardownEvent(shared, "tenant-acme", "EV1", NOW_MS);
    expect(out).toEqual({ kind: "not_found" });
    expect(eventsSend).not.toHaveBeenCalled();
  });

  it("should skip and not publish for rows already DELETING / DELETED", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() });
    ddbSend.mockResolvedValueOnce({
      Items: [
        dep({ jobId: "01A", status: "DELETING" }),
        dep({ jobId: "01B", status: "DELETED" }),
        dep({ jobId: "01C", status: "COMPLETE" }),
      ],
    });
    ddbSend.mockResolvedValue({});
    eventsSend.mockResolvedValue({});

    const out = await bulkTeardownEvent(shared, "tenant-acme", "EV1", NOW_MS);
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") {
      expect(out.result.enqueued).toBe(1);
      expect(out.result.skipped).toBe(2);
    }
  });

  it("should include AssumeRole metadata in DeployDeleteRequested detail (#758)", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() });
    ddbSend.mockResolvedValueOnce({
      Items: [
        dep({
          jobId: "01A",
          competitorRoleArn: "arn:aws:iam::999999999999:role/TenkaCloud-CompetitorDeploy-Role",
          externalIdParameterName: "/development/tenants/tenant-acme/external-id",
        }),
      ],
    });
    ddbSend.mockResolvedValue({});
    eventsSend.mockResolvedValue({});

    await bulkTeardownEvent(shared, "tenant-acme", "EV1", NOW_MS);

    const putCmd = eventsSend.mock.calls[0]?.[0] as PutEventsCommand;
    const detail = JSON.parse(String(putCmd.input.Entries?.[0]?.Detail)) as {
      competitorRoleArn?: string;
      externalIdParameterName?: string;
    };
    expect(detail.competitorRoleArn).toBe(
      "arn:aws:iam::999999999999:role/TenkaCloud-CompetitorDeploy-Role",
    );
    expect(detail.externalIdParameterName).toBe("/development/tenants/tenant-acme/external-id");
  });

  it("should return enqueued=0 when the event exists but has 0 deployments (not yet deployed)", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() });
    ddbSend.mockResolvedValueOnce({ Items: [] });

    const out = await bulkTeardownEvent(shared, "tenant-acme", "EV1", NOW_MS);
    expect(out).toEqual({
      kind: "ok",
      result: { eventId: "EV1", enqueued: 0, skipped: 0, failed: 0 },
    });
    expect(eventsSend).not.toHaveBeenCalled();
  });

  it("should skip and not propagate exceptions on ConditionalCheckFailed (concurrent update)", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    // Event status update (= 後続の 4th call) は通常 success を返す fallback。
    // #557 で 1 deployment + Event status の 2 件目 UpdateCommand が増えたため。
    ddbSend.mockResolvedValue({});
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() });
    ddbSend.mockResolvedValueOnce({ Items: [dep()] });
    ddbSend.mockImplementationOnce(async (cmd) => {
      if (cmd instanceof UpdateCommand) {
        const err: Error & { name?: string } = new Error("conditional check failed");
        err.name = "ConditionalCheckFailedException";
        throw err;
      }
      return {};
    });

    const out = await bulkTeardownEvent(shared, "tenant-acme", "EV1", NOW_MS);
    expect(out).toEqual({
      kind: "ok",
      result: { eventId: "EV1", enqueued: 0, skipped: 1, failed: 0 },
    });
    expect(eventsSend).not.toHaveBeenCalled();
  });

  it("#1797: should compensate (DELETING -> FAILED) and count rows whose PutEvents entry failed (FailedEntryCount > 0)", async () => {
    // EventBridge PutEvents は HTTP 200 でも個別 entry が落ちる (FailedEntryCount > 0)。 旧コードは
    // これを無視し teardown event を silent drop → stack orphan。 publish できなかった行は
    // DELETING のままだと再 DELETE でも skip され永久に消えない。 FAILED に巻き戻して retry 可能化する。
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() }); // Get(Event)
    ddbSend.mockResolvedValueOnce({ Items: [dep({ jobId: "01A" }), dep({ jobId: "01B" })] }); // Query
    ddbSend.mockResolvedValue({}); // DELETING transitions + Event TEARDOWN + compensation
    // 200 だが 2 件目 (01B) の entry が失敗。 response.Entries は入力 Entries と同順。
    eventsSend.mockResolvedValue({
      FailedEntryCount: 1,
      Entries: [{ EventId: "ok" }, { ErrorCode: "ThrottlingException", ErrorMessage: "rate" }],
    });

    const out = await bulkTeardownEvent(shared, "tenant-acme", "EV1", NOW_MS);
    expect(out).toEqual({
      kind: "ok",
      result: { eventId: "EV1", enqueued: 1, skipped: 0, failed: 1 },
    });

    const compensations = ddbSend.mock.calls
      .map((c) => c[0])
      .filter((c): c is UpdateCommand => c instanceof UpdateCommand)
      .filter((c) => c.input.ExpressionAttributeValues?.[":failed"] === "FAILED");
    expect(compensations).toHaveLength(1);
    expect(compensations[0]?.input.Key?.PK).toBe("DEPLOYMENT#01B");
    // DELETING の行だけを FAILED に倒す (= 他経路で既に終端化した行は踏まない)。
    expect(compensations[0]?.input.ConditionExpression).toContain(":deleting");
  });

  it("#1797: should compensate every row in a chunk that PutEvents rejected entirely", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() });
    ddbSend.mockResolvedValueOnce({ Items: [dep({ jobId: "01A" }), dep({ jobId: "01B" })] });
    ddbSend.mockResolvedValue({});
    eventsSend.mockRejectedValue(new Error("EventBridge unavailable")); // chunk 全体が reject

    const out = await bulkTeardownEvent(shared, "tenant-acme", "EV1", NOW_MS);
    expect(out).toEqual({
      kind: "ok",
      result: { eventId: "EV1", enqueued: 0, skipped: 0, failed: 2 },
    });

    const compensated = ddbSend.mock.calls
      .map((c) => c[0])
      .filter((c): c is UpdateCommand => c instanceof UpdateCommand)
      .filter((c) => c.input.ExpressionAttributeValues?.[":failed"] === "FAILED")
      .map((c) => c.input.Key?.PK)
      .sort();
    expect(compensated).toEqual(["DEPLOYMENT#01A", "DEPLOYMENT#01B"]);
  });

  it("should still complete deployment delete without propagating exceptions even if Event status update hits CCF (e.g. ARCHIVED) (#557)", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent({ status: "ARCHIVED" }) });
    // GetCommand 後の "ARCHIVED" 判定は handler では行わないので Query へ進む。
    ddbSend.mockResolvedValueOnce({ Items: [dep()] });
    // deployment update success
    ddbSend.mockResolvedValueOnce({});
    eventsSend.mockResolvedValue({});
    // Event status update で CCF を投げる (= ARCHIVED から踏み越えられない条件)
    ddbSend.mockImplementationOnce(async (cmd) => {
      if (
        cmd instanceof UpdateCommand &&
        cmd.input.ExpressionAttributeValues?.[":teardown"] === "TEARDOWN"
      ) {
        const err: Error & { name?: string } = new Error("archived");
        err.name = "ConditionalCheckFailedException";
        throw err;
      }
      return {};
    });

    const out = await bulkTeardownEvent(shared, "tenant-acme", "EV1", NOW_MS);
    // handler は正常に完了 (= deployment は DELETING に倒した)
    expect(out.kind).toBe("ok");
  });

  it("#1810: should tear down a FAILED deployment whose stackId is empty (fallback to namePrefix)", async () => {
    // 失敗 deployment は stack ARN 記録前に終わると stackId="" (空文字、null ではない)。
    // 旧コードは `stackId ?? namePrefix` で空文字を fallback できず stackName="" → skip し、
    // 失敗 stack を orphan 化していた。namePrefix で delete-stack できるよう enqueue されること。
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() }); // Get(Event)
    ddbSend.mockResolvedValueOnce({
      Items: [dep({ jobId: "01FAIL", status: "FAILED", stackId: "", namePrefix: "tc-p-team-9" })],
    });
    ddbSend.mockResolvedValue({}); // transition + Event status
    eventsSend.mockResolvedValue({});

    const out = await bulkTeardownEvent(shared, "tenant-acme", "EV1", NOW_MS);
    expect(out).toEqual({
      kind: "ok",
      result: { eventId: "EV1", enqueued: 1, skipped: 0, failed: 0 },
    });
    const putCmd = eventsSend.mock.calls[0]?.[0] as PutEventsCommand;
    const detail = JSON.parse(String(putCmd.input.Entries?.[0]?.Detail)) as { stackName?: string };
    expect(detail.stackName).toBe("tc-p-team-9");
  });

  it("Deployments query should hit GSI1 (TENANT) and filter eventId in-memory", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() });
    ddbSend.mockResolvedValueOnce({ Items: [] });

    await bulkTeardownEvent(shared, "tenant-acme", "EV1", NOW_MS);
    // 1 件目: Get(Event)
    expect(ddbSend.mock.calls[0]?.[0]).toBeInstanceOf(GetCommand);
    // 2 件目: Query(Deployments GSI1)
    const queryCmd = ddbSend.mock.calls[1]?.[0] as QueryCommand;
    expect(queryCmd.input.IndexName).toBe("GSI1");
    expect(queryCmd.input.ExpressionAttributeValues?.[":pk"]).toBe("TENANT#tenant-acme");
    expect(eventsSend).not.toHaveBeenCalled();
  });
});

/**
 * [#2571] Bulk teardown for a non-AWS single-provider row (gcp/azure/sakura).
 * Mirrors `deploy-delete.test.ts`'s "requestTeardown (non-AWS runtime via
 * adapter)" suite: the real Sakura AppRun adapter runs end-to-end (SSM
 * credential read + `fetch` stub) rather than mocking `selectAdapter` itself,
 * so the test proves the whole seam wires together (`buildAdapterDependencies`
 * -> `selectAdapter` -> `adapter.destroy`) exactly like the single-deploy path.
 *
 * Before this fix, `getBulkTeardownTarget` required non-empty `region` /
 * `awsAccountId` — both persisted as `""` for a non-AWS row (#2571
 * plan-builder) — so every such row was silently `skipped` and its cloud
 * resources leaked on event teardown.
 */
describe("bulkTeardownEvent (non-AWS runtime via adapter, #2571)", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  // [#2571 review-fix] Reuses the top-level `buildShared`'s `over` param instead
  // of cloning its whole field list a second time — `ssm` is the only field this
  // suite needs on top of the shared default fixture.
  function buildSakuraShared(): {
    shared: EventSharedResources;
    ddbSend: ReturnType<typeof vi.fn>;
    eventsSend: ReturnType<typeof vi.fn>;
    ssmSend: ReturnType<typeof vi.fn>;
  } {
    const ssmSend = vi.fn(async () => ({
      Parameter: { Value: JSON.stringify({ accessToken: "tok", accessTokenSecret: "sec" }) },
    }));
    const { shared, ddbSend, eventsSend } = buildShared({
      ssm: { send: ssmSend } as unknown as EventSharedResources["ssm"],
    });
    return { shared, ddbSend, eventsSend, ssmSend };
  }

  const sakuraDep = (over: Record<string, unknown> = {}) => ({
    jobId: "01SAKURA",
    eventId: "EV1",
    tenantId: "tenant-acme",
    problemId: "p",
    teamName: "team-1",
    namePrefix: "tc-p-team-1",
    status: "COMPLETE",
    runtimeProvider: "sakura",
    runtimeEngine: "apprun",
    runtimeEntry: "registry/img:1",
    awsAccountId: "",
    region: "",
    ...over,
  });

  it("should destroy a non-AWS single-provider row via its adapter and count it as enqueued", async () => {
    const { shared, ddbSend, eventsSend, ssmSend } = buildSakuraShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() }); // Get(Event)
    ddbSend.mockResolvedValueOnce({ Items: [sakuraDep()] }); // Query(Deployments)
    ddbSend.mockResolvedValue({}); // DELETING transition + Event TEARDOWN update
    const appRunFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: "a1", name: "tc-p-team-1" }] }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", appRunFetch);

    const out = await bulkTeardownEvent(shared, "tenant-acme", "EV1", NOW_MS);
    expect(out).toEqual({
      kind: "ok",
      result: { eventId: "EV1", enqueued: 1, skipped: 0, failed: 0 },
    });
    // No EventBridge publish for this row — it never had a CFn stack to delete.
    expect(eventsSend).not.toHaveBeenCalled();
    expect(ssmSend).toHaveBeenCalled();
    expect(appRunFetch.mock.calls[1]?.[1]?.method).toBe("DELETE");
  });

  it("should compensate DELETING -> FAILED, count as failed, and emit a loud trace when adapter.destroy throws", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { shared, ddbSend, eventsSend } = buildSakuraShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() });
    ddbSend.mockResolvedValueOnce({ Items: [sakuraDep()] });
    ddbSend.mockResolvedValue({});
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(new Response("boom", { status: 500 })), // findByName list fails
    );

    const out = await bulkTeardownEvent(shared, "tenant-acme", "EV1", NOW_MS);
    expect(out).toEqual({
      kind: "ok",
      result: { eventId: "EV1", enqueued: 0, skipped: 0, failed: 1 },
    });
    expect(eventsSend).not.toHaveBeenCalled();
    const compensations = ddbSend.mock.calls
      .map((c) => c[0])
      .filter((c): c is UpdateCommand => c instanceof UpdateCommand)
      .filter((c) => c.input.ExpressionAttributeValues?.[":failed"] === "FAILED");
    expect(compensations).toHaveLength(1);
    expect(compensations[0]?.input.Key?.PK).toBe("DEPLOYMENT#01SAKURA");
    // [#2571 review-fix] The reason must not be discarded by a bare `catch {}` —
    // it should be loud in CloudWatch (jobId/provider/engine/reason).
    const trace = logSpy.mock.calls
      .map((c) => String(c[0]))
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .find((t) => t.event === "bulk-teardown.adapter.failed");
    expect(trace).toMatchObject({ jobId: "01SAKURA", provider: "sakura", engine: "apprun" });
    expect(String(trace?.reason)).toBeTruthy();
    logSpy.mockRestore();
  });

  it("should stringify a non-Error rejection from adapter.destroy in the failure trace reason", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { shared, ddbSend, eventsSend, ssmSend } = buildSakuraShared();
    ssmSend.mockRejectedValueOnce("boom (not an Error instance)");
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() });
    ddbSend.mockResolvedValueOnce({ Items: [sakuraDep()] });
    ddbSend.mockResolvedValue({});

    const out = await bulkTeardownEvent(shared, "tenant-acme", "EV1", NOW_MS);
    expect(out).toEqual({
      kind: "ok",
      result: { eventId: "EV1", enqueued: 0, skipped: 0, failed: 1 },
    });
    expect(eventsSend).not.toHaveBeenCalled();
    const trace = logSpy.mock.calls
      .map((c) => String(c[0]))
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .find((t) => t.event === "bulk-teardown.adapter.failed");
    expect(trace?.reason).toBe("boom (not an Error instance)");
    logSpy.mockRestore();
  });

  it("should skip a non-AWS single-provider row when ssm is unwired (dormant, unchanged behavior) and emit a loud trace", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { shared, ddbSend, eventsSend } = buildShared(); // default shared has no ssm field
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() });
    ddbSend.mockResolvedValueOnce({ Items: [sakuraDep()] });
    ddbSend.mockResolvedValue({});

    const out = await bulkTeardownEvent(shared, "tenant-acme", "EV1", NOW_MS);
    expect(out).toEqual({
      kind: "ok",
      result: { eventId: "EV1", enqueued: 0, skipped: 1, failed: 0 },
    });
    expect(eventsSend).not.toHaveBeenCalled();
    // [#2571 review-fix] `!shared.ssm` used to fold this row into `skipped` in
    // total silence — the exact leak class #2571 fixes. It must now be loud.
    const trace = logSpy.mock.calls
      .map((c) => String(c[0]))
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .find((t) => t.event === "bulk-teardown.adapter.unavailable");
    expect(trace).toMatchObject({ jobId: "01SAKURA", provider: "sakura", engine: "apprun" });
    logSpy.mockRestore();
  });

  it("should skip a non-AWS row that is missing jobId, without attempting a transition or adapter dispatch", async () => {
    const { shared, ddbSend, eventsSend, ssmSend } = buildSakuraShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() });
    ddbSend.mockResolvedValueOnce({ Items: [sakuraDep({ jobId: undefined })] });
    ddbSend.mockResolvedValue({});

    const out = await bulkTeardownEvent(shared, "tenant-acme", "EV1", NOW_MS);
    expect(out).toEqual({
      kind: "ok",
      result: { eventId: "EV1", enqueued: 0, skipped: 1, failed: 0 },
    });
    expect(eventsSend).not.toHaveBeenCalled();
    expect(ssmSend).not.toHaveBeenCalled();
  });

  it("should fall back to an empty team slug for a non-AWS row missing teamName, instead of throwing", async () => {
    const { shared, ddbSend, eventsSend, ssmSend } = buildSakuraShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() });
    ddbSend.mockResolvedValueOnce({ Items: [sakuraDep({ teamName: undefined })] });
    ddbSend.mockResolvedValue({});
    const appRunFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: "a1", name: "tc-p-team-1" }] }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", appRunFetch);

    const out = await bulkTeardownEvent(shared, "tenant-acme", "EV1", NOW_MS);
    expect(out).toEqual({
      kind: "ok",
      result: { eventId: "EV1", enqueued: 1, skipped: 0, failed: 0 },
    });
    expect(ssmSend).toHaveBeenCalled();
    expect(eventsSend).not.toHaveBeenCalled();
  });

  it("should fall back to empty-string namePrefix/region/awsAccountId in the destroy call for a row missing them", async () => {
    const { shared, ddbSend, eventsSend, ssmSend } = buildSakuraShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() });
    ddbSend.mockResolvedValueOnce({
      Items: [sakuraDep({ namePrefix: undefined, region: undefined, awsAccountId: undefined })],
    });
    ddbSend.mockResolvedValue({});
    // findByName("") never matches an app in the list -> deleteApplication is a
    // no-op (idempotent) rather than throwing -- proves the "" fallbacks flow
    // through cleanly instead of a `String(undefined)` crash.
    const appRunFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    vi.stubGlobal("fetch", appRunFetch);

    const out = await bulkTeardownEvent(shared, "tenant-acme", "EV1", NOW_MS);
    expect(out).toEqual({
      kind: "ok",
      result: { eventId: "EV1", enqueued: 1, skipped: 0, failed: 0 },
    });
    expect(eventsSend).not.toHaveBeenCalled();
    expect(ssmSend).toHaveBeenCalled();
    expect(appRunFetch).toHaveBeenCalledTimes(1);
  });

  it("should treat a row with a partial runtime combo (provider set, engine/entry missing) as the legacy AWS/CFn path", async () => {
    // [#2571 review-fix] `resolveItemRuntime` only recognizes a runtime when all
    // 3 fields (provider/engine/entry) are present; a partial combo must default
    // to aws/cloudformation exactly like a row with no runtime fields at all —
    // NOT silently attempt (and fail) an adapter dispatch.
    const { shared, ddbSend, eventsSend } = buildShared(); // no ssm wired
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() });
    ddbSend.mockResolvedValueOnce({
      Items: [dep({ jobId: "01PARTIAL", runtimeProvider: "gcp" })], // engine/entry missing
    });
    ddbSend.mockResolvedValue({});
    eventsSend.mockResolvedValue({});

    const out = await bulkTeardownEvent(shared, "tenant-acme", "EV1", NOW_MS);
    expect(out).toEqual({
      kind: "ok",
      result: { eventId: "EV1", enqueued: 1, skipped: 0, failed: 0 },
    });
    const putCmd = eventsSend.mock.calls[0]?.[0] as PutEventsCommand;
    expect(putCmd.input.Entries?.[0]?.DetailType).toBe("DeployDeleteRequested");
  });

  it("should skip a non-AWS row when the DELETING transition hits a concurrent-update conflict", async () => {
    const { shared, ddbSend, eventsSend, ssmSend } = buildSakuraShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() });
    ddbSend.mockResolvedValueOnce({ Items: [sakuraDep()] });
    ddbSend.mockImplementationOnce(async (cmd) => {
      if (cmd instanceof UpdateCommand) {
        const err: Error & { name?: string } = new Error("conditional check failed");
        err.name = "ConditionalCheckFailedException";
        throw err;
      }
      return {};
    });
    ddbSend.mockResolvedValue({}); // subsequent Event TEARDOWN update succeeds

    const out = await bulkTeardownEvent(shared, "tenant-acme", "EV1", NOW_MS);
    expect(out).toEqual({
      kind: "ok",
      result: { eventId: "EV1", enqueued: 0, skipped: 1, failed: 0 },
    });
    expect(eventsSend).not.toHaveBeenCalled();
    // The transition conflict must short-circuit before ever reaching the adapter.
    expect(ssmSend).not.toHaveBeenCalled();
  });

  it("should compensate and count as failed (not crash the whole teardown) when selectAdapter rejects an unrecognized runtime triple", async () => {
    // [#2571 review-fix / fix 1] Before this fix, `buildAdapterDependencies` +
    // `selectAdapter` ran OUTSIDE the try, AFTER the row had already
    // transitioned to DELETING. `selectAdapter` throws `RuntimeNotSupportedError`
    // synchronously for an unrecognized (provider, engine) pair (e.g. a
    // corrupted row) -- with the old ordering, nothing caught that throw and it
    // rejected the whole `Promise.all` in `bulkTeardownEvent`, dragging every
    // OTHER row (including this valid sakura one) down with it. This proves the
    // bad row is isolated: it compensates to FAILED on its own, and the good row
    // alongside it still tears down successfully.
    const { shared, ddbSend, eventsSend, ssmSend } = buildSakuraShared();
    ddbSend.mockResolvedValueOnce({ Item: sampleEvent() });
    ddbSend.mockResolvedValueOnce({
      Items: [
        sakuraDep({
          jobId: "01BAD",
          runtimeProvider: "unknown-cloud",
          runtimeEngine: "unknown-engine",
          runtimeEntry: "x",
        }),
        sakuraDep(), // a normal, valid row alongside it (jobId: 01SAKURA)
      ],
    });
    ddbSend.mockResolvedValue({});
    const appRunFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: "a1", name: "tc-p-team-1" }] }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", appRunFetch);

    const out = await bulkTeardownEvent(shared, "tenant-acme", "EV1", NOW_MS);
    expect(out).toEqual({
      kind: "ok",
      result: { eventId: "EV1", enqueued: 1, skipped: 0, failed: 1 },
    });
    expect(ssmSend).toHaveBeenCalled();
    expect(eventsSend).not.toHaveBeenCalled();
    const compensations = ddbSend.mock.calls
      .map((c) => c[0])
      .filter((c): c is UpdateCommand => c instanceof UpdateCommand)
      .filter((c) => c.input.ExpressionAttributeValues?.[":failed"] === "FAILED");
    expect(compensations).toHaveLength(1);
    expect(compensations[0]?.input.Key?.PK).toBe("DEPLOYMENT#01BAD");
  });
});
