import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import type { PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { GetCommand, PutCommand, type QueryCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fireDisruption,
  isEventOwnedByTenant,
  listDisruptionAudit,
  listDisruptionCatalog,
} from "../../lib/problem-deploy/handlers/event-handler/disruption-fire";
import type { EventSharedResources } from "../../lib/problem-deploy/handlers/event-handler/shared";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers";

const NOW_MS = 1_700_000_000_000;

function buildShared(): {
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
    disruptionsTableName: "TestDisruptions",
    eventBusName: "test-bus",
    env: "development",
    ddb: { send: ddbSend } as unknown as EventSharedResources["ddb"],
    events: { send: eventsSend } as unknown as EventSharedResources["events"],
    problemsCatalog: { "battle-1": "problems/battles/battle-1" },
    problemsDisruptions: {
      "battle-1": [
        {
          id: "router-throttle",
          name: "Throttle test",
          eventDetailType: "RedTeamRouterThrottleFired",
          operatorEditable: ["throttleRps", "durationSec"],
          parameters: { throttleRps: 5, durationSec: 60 },
        },
      ],
    },
  };
  return { shared, ddbSend, eventsSend };
}

const baseInput = (over: Partial<Parameters<typeof fireDisruption>[1]> = {}) => ({
  tenantId: "tenant-acme",
  eventId: "01HZX0K3M3K9ZQHB3MRQHBA1B2",
  problemId: "battle-1",
  disruptionId: "router-throttle",
  parameters: {},
  scope: "all" as const,
  targetTeamIds: [],
  requestId: "req-12345678",
  firedBy: "cognito-sub-1",
  nowMs: NOW_MS,
  ...over,
});

describe("fireDisruption (#888)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should return unknown_problem (no entry in problemsDisruptions)", async () => {
    const { shared } = buildShared();
    const out = await fireDisruption(shared, baseInput({ problemId: "unknown" }));
    expect(out.kind).toBe("unknown_problem");
  });

  it("should return unknown_disruption (disruptionId not in catalog)", async () => {
    const { shared } = buildShared();
    const out = await fireDisruption(shared, baseInput({ disruptionId: "nope" }));
    expect(out.kind).toBe("unknown_disruption");
  });

  it("should return invalid_parameters (key outside operatorEditable allow-list)", async () => {
    const { shared } = buildShared();
    const out = await fireDisruption(shared, baseInput({ parameters: { evilKey: "exfil" } }));
    expect(out.kind).toBe("invalid_parameters");
  });

  it("scope=all で全 team を target にし、 idempotency Put → EventBridge → audit Put の順", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    // 1. team list query
    ddbSend.mockResolvedValueOnce({
      Items: [{ teamId: "T1" }, { teamId: "T2" }],
    });
    // 2. idempotency Put (claim)
    ddbSend.mockResolvedValueOnce({});
    // 3. PutEvents
    eventsSend.mockResolvedValueOnce({ FailedEntryCount: 0, Entries: [{}, {}] });
    // 4. audit Put
    ddbSend.mockResolvedValueOnce({});

    const out = await fireDisruption(shared, baseInput());
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.result.affectedTeamIds).toEqual(["T1", "T2"]);
    const evCmd = eventsSend.mock.calls[0]?.[0] as PutEventsCommand;
    expect(evCmd.input.Entries).toHaveLength(2);
    expect(evCmd.input.Entries?.[0]?.DetailType).toBe("RedTeamRouterThrottleFired");
    // PR #889 review: publish detail も mergedParameters を載せる
    const detail = JSON.parse(evCmd.input.Entries?.[0]?.Detail ?? "{}");
    expect(detail.parameters).toMatchObject({ throttleRps: 5, durationSec: 60 });
    // immediate fire: published detail に afterMinutes を載せない (regression)
    expect(detail).not.toHaveProperty("afterMinutes");
  });

  it("scheduled fire: published detail に afterMinutes、 audit に scheduledFor を載せる", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [{ teamId: "T1" }] }); // team list
    ddbSend.mockResolvedValueOnce({}); // idempotency claim
    eventsSend.mockResolvedValueOnce({ FailedEntryCount: 0, Entries: [{}] }); // PutEvents
    ddbSend.mockResolvedValueOnce({}); // audit Put

    const out = await fireDisruption(shared, baseInput({ afterMinutes: 30 }));
    expect(out.kind).toBe("ok");
    // published detail carries afterMinutes so the executor defers the inject
    const evCmd = eventsSend.mock.calls[0]?.[0] as PutEventsCommand;
    const detail = JSON.parse(evCmd.input.Entries?.[0]?.Detail ?? "{}");
    expect(detail.afterMinutes).toBe(30);
    // audit row records the scheduled-for time (firedAt + 30m)
    const auditPut = ddbSend.mock.calls.find((c) =>
      String((c[0] as { input?: { Item?: { SK?: string } } }).input?.Item?.SK).startsWith("AUDIT#"),
    );
    expect(auditPut).toBeDefined();
    if (!auditPut) throw new Error("Expected an AUDIT# PutCommand");
    const auditItem = (auditPut[0] as { input: { Item: { scheduledFor?: string } } }).input.Item;
    expect(auditItem.scheduledFor).toBe(new Date(NOW_MS + 30 * 60_000).toISOString());
  });

  it("recurring fire: published detail に recurrence、 RECUR# registry を書く", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [{ teamId: "T1" }] }); // team list
    ddbSend.mockResolvedValueOnce({}); // idempotency claim
    eventsSend.mockResolvedValueOnce({ FailedEntryCount: 0, Entries: [{}] }); // PutEvents
    ddbSend.mockResolvedValueOnce({}); // audit Put
    ddbSend.mockResolvedValueOnce({}); // RECUR# registry Put

    const out = await fireDisruption(
      shared,
      baseInput({ recurrence: { intervalMinutes: 5, maxFires: 6 } }),
    );
    expect(out.kind).toBe("ok");
    // published detail carries recurrence so the executor creates the rate schedule
    const evCmd = eventsSend.mock.calls[0]?.[0] as PutEventsCommand;
    const detail = JSON.parse(evCmd.input.Entries?.[0]?.Detail ?? "{}");
    expect(detail.recurrence).toEqual({ intervalMinutes: 5, maxFires: 6 });
    // RECUR# registry row written with affectedTeamIds + endsAt (= interval×maxFires later)
    const recurPut = ddbSend.mock.calls.find((c) =>
      String((c[0] as { input?: { Item?: { SK?: string } } }).input?.Item?.SK).startsWith("RECUR#"),
    );
    expect(recurPut).toBeDefined();
    if (!recurPut) throw new Error("Expected a RECUR# PutCommand");
    const recurItem = (recurPut[0] as { input: { Item: Record<string, unknown> } }).input.Item;
    expect(recurItem.affectedTeamIds).toEqual(["T1"]);
    expect(recurItem.intervalMinutes).toBe(5);
    expect(recurItem.maxFires).toBe(6);
    expect(recurItem.endsAt).toBe(new Date(NOW_MS + 5 * 6 * 60_000).toISOString());
  });

  it("scope=team で targetTeamIds dedupe + subset", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Items: [{ teamId: "T1" }, { teamId: "T2" }, { teamId: "T3" }],
    });
    ddbSend.mockResolvedValueOnce({}); // idempotency Put
    eventsSend.mockResolvedValueOnce({ FailedEntryCount: 0, Entries: [{}] });
    ddbSend.mockResolvedValueOnce({}); // audit Put

    const out = await fireDisruption(
      shared,
      baseInput({ scope: "team", targetTeamIds: ["T2", "T2", "T999"] }),
    );
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    // dedupe + existence filter で T2 だけ残る
    expect(out.result.affectedTeamIds).toEqual(["T2"]);
  });

  it("idempotency: claim Put が CCF → duplicate を返す (race-safe)", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [{ teamId: "T1" }] }); // team list
    // idempotency Put が ConditionalCheckFailed
    const ccf = new ConditionalCheckFailedException({
      message: "exists",
      $metadata: {},
    });
    ddbSend.mockRejectedValueOnce(ccf);
    // 既存 row を Get で取得
    ddbSend.mockResolvedValueOnce({
      Item: {
        auditId: "01HPRIOR",
        firedAt: "2026-01-01T00:00:00.000Z",
        targetTeamIds: ["T1"],
        scope: "all",
      },
    });

    const out = await fireDisruption(shared, baseInput());
    expect(out.kind).toBe("duplicate");
    if (out.kind !== "duplicate") return;
    expect(out.result.auditId).toBe("01HPRIOR");
    expect(eventsSend).not.toHaveBeenCalled();
  });

  it("should return no_targets (no teams under the event)", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [] }); // team list 空
    const out = await fireDisruption(shared, baseInput());
    expect(out.kind).toBe("no_targets");
  });

  it("should throw and not write audit rows when PutEvents reports FailedEntryCount > 0", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [{ teamId: "T1" }] }); // team list
    ddbSend.mockResolvedValueOnce({}); // idempotency Put
    eventsSend.mockResolvedValueOnce({
      FailedEntryCount: 1,
      Entries: [{ ErrorCode: "InternalFailure", ErrorMessage: "transient" }],
    });

    await expect(fireDisruption(shared, baseInput())).rejects.toThrow(/partial failure/);
    // audit Put は呼ばれない
    const puts = ddbSend.mock.calls
      .map((c) => c[0])
      .filter((c): c is PutCommand => c instanceof PutCommand);
    // idempotency Put 1 件のみ (= audit は走らない)
    expect(puts).toHaveLength(1);
  });

  it("should fall back to errorCode=unknown when the whole PutEvents request rejects (issue #2210)", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [{ teamId: "T1" }] }); // team list
    ddbSend.mockResolvedValueOnce({}); // idempotency Put
    eventsSend.mockRejectedValueOnce(new Error("network down"));

    await expect(fireDisruption(shared, baseInput())).rejects.toThrow(
      /partial failure: team\[T1\]=unknown/,
    );
  });

  it("audit row に mergedParameters / firedBy / scope / requestId が書かれる", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [{ teamId: "T1" }] });
    ddbSend.mockResolvedValueOnce({}); // idempotency Put
    eventsSend.mockResolvedValueOnce({ FailedEntryCount: 0, Entries: [{}] });
    ddbSend.mockResolvedValueOnce({}); // audit Put

    await fireDisruption(shared, baseInput({ parameters: { throttleRps: 10 } }));
    const putCmds = ddbSend.mock.calls
      .map((c) => c[0])
      .filter((c): c is PutCommand => c instanceof PutCommand);
    expect(putCmds).toHaveLength(2);
    // 1st = idempotency, 2nd = audit
    const auditItem = putCmds[1]?.input.Item;
    expect(auditItem?.firedBy).toBe("cognito-sub-1");
    expect(auditItem?.requestId).toBe("req-12345678");
    expect(auditItem?.scope).toBe("all");
    expect(auditItem?.parameters).toMatchObject({ throttleRps: 10, durationSec: 60 });
  });
});

describe("listDisruptionAudit (#888)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("event 直下の AUDIT# row のみを返し、 ScanIndexForward=false で時系列降順", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Items: [
        {
          auditId: "A1",
          tenantId: "tenant-acme",
          eventId: "EV1",
          problemId: "battle-1",
          disruptionId: "router-throttle",
          firedBy: "op-1",
          firedAt: "2026-05-12T00:00:00.000Z",
          scope: "all",
          targetTeamIds: ["T1"],
          parameters: { throttleRps: 5 },
          requestId: "r1",
          expiresAt: 1_700_000_000,
        },
      ],
    });
    const out = await listDisruptionAudit(shared, "EV1");
    expect(out.items).toHaveLength(1);
    expect(out.items[0]?.auditId).toBe("A1");
    const qry = ddbSend.mock.calls[0]?.[0] as QueryCommand;
    expect(qry.input.ScanIndexForward).toBe(false);
    expect(qry.input.ExpressionAttributeValues?.[":ap"]).toBe("AUDIT#");
  });
});

describe("listDisruptionCatalog (#888)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should surface only disruptions matching event problems[] into the catalog", async () => {
    const { shared, ddbSend } = buildShared();
    // #2436: repository seam 経由になり (shared, tenantId, eventId) 署名。 getEvent が tenant scope を
    // 内包するので fixture Item に tenantId を持たせ、 seam の tenant 照合を通過させる。
    ddbSend.mockResolvedValueOnce({
      Item: {
        tenantId: "tenant-acme",
        problems: [{ problemId: "battle-1" }, { problemId: "unknown-problem" }],
      },
    });
    const out = await listDisruptionCatalog(shared, "tenant-acme", "EV1");
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0]?.problemId).toBe("battle-1");
    expect(out.entries[0]?.disruption.id).toBe("router-throttle");
    expect(ddbSend.mock.calls[0]?.[0]).toBeInstanceOf(GetCommand);
  });
});

describe("isEventOwnedByTenant (#888 PR #889)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("event item が存在し tenantId 一致なら true", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: { tenantId: "tenant-acme" } });
    expect(await isEventOwnedByTenant(shared, "EV1", "tenant-acme")).toBe(true);
  });

  it("tenantId 不一致なら false (= 他 tenant の event を覗かせない)", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: { tenantId: "tenant-other" } });
    expect(await isEventOwnedByTenant(shared, "EV1", "tenant-acme")).toBe(false);
  });

  it("event 不在なら false", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: undefined });
    expect(await isEventOwnedByTenant(shared, "EV1", "tenant-acme")).toBe(false);
  });
});
