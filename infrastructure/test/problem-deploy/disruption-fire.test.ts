import type { PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { GetCommand, PutCommand, type QueryCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fireDisruption,
  listDisruptionAudit,
  listDisruptionCatalog,
} from "../../lib/problem-deploy/handlers/event-handler/disruption-fire";
import type { EventSharedResources } from "../../lib/problem-deploy/handlers/event-handler/shared";

const NOW_MS = 1_700_000_000_000;

function buildShared(): {
  shared: EventSharedResources;
  ddbSend: ReturnType<typeof vi.fn>;
  eventsSend: ReturnType<typeof vi.fn>;
} {
  const ddbSend = vi.fn();
  const eventsSend = vi.fn();
  const shared: EventSharedResources = {
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

  it("unknown_problem を返すべき (problemsDisruptions に entry が無い)", async () => {
    const { shared } = buildShared();
    const out = await fireDisruption(shared, baseInput({ problemId: "unknown" }));
    expect(out.kind).toBe("unknown_problem");
  });

  it("unknown_disruption を返すべき (disruptionId が catalog に無い)", async () => {
    const { shared } = buildShared();
    const out = await fireDisruption(shared, baseInput({ disruptionId: "nope" }));
    expect(out.kind).toBe("unknown_disruption");
  });

  it("invalid_parameters を返すべき (operatorEditable allow-list 外の key)", async () => {
    const { shared } = buildShared();
    const out = await fireDisruption(shared, baseInput({ parameters: { evilKey: "exfil" } }));
    expect(out.kind).toBe("invalid_parameters");
  });

  it("scope=all で全 team を target にし EventBridge + audit に書くべき", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    // 1. idempotency Query (空)
    ddbSend.mockResolvedValueOnce({ Items: [] });
    // 2. team list query
    ddbSend.mockResolvedValueOnce({
      Items: [
        { teamId: "T1", PK: "EVENT#X", SK: "TEAM#T1" },
        { teamId: "T2", PK: "EVENT#X", SK: "TEAM#T2" },
      ],
    });
    // 3. PutEvents
    eventsSend.mockResolvedValueOnce({});
    // 4. audit PutItem
    ddbSend.mockResolvedValueOnce({});
    // 5. idempotency PutItem
    ddbSend.mockResolvedValueOnce({});

    const out = await fireDisruption(shared, baseInput());
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.result.affectedTeamIds).toEqual(["T1", "T2"]);
    // PutEvents 1 call (2 entries)
    const evCmd = eventsSend.mock.calls[0]?.[0] as PutEventsCommand;
    expect(evCmd.input.Entries).toHaveLength(2);
    expect(evCmd.input.Entries?.[0]?.DetailType).toBe("RedTeamRouterThrottleFired");
  });

  it("scope=team で targetTeamIds の subset のみに publish", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [] });
    ddbSend.mockResolvedValueOnce({
      Items: [{ teamId: "T1" }, { teamId: "T2" }, { teamId: "T3" }],
    });
    eventsSend.mockResolvedValueOnce({});
    ddbSend.mockResolvedValueOnce({});
    ddbSend.mockResolvedValueOnce({});

    const out = await fireDisruption(
      shared,
      baseInput({ scope: "team", targetTeamIds: ["T2", "T999"] }),
    );
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    // T999 は team 一覧に無いので除外、 T2 のみ残る
    expect(out.result.affectedTeamIds).toEqual(["T2"]);
  });

  it("idempotency: 同 requestId の 2 度目は duplicate + 前回 result を返す", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    // 1st: idempotency Query が prior row を返す
    ddbSend.mockResolvedValueOnce({
      Items: [
        {
          auditId: "01HPRIOR",
          firedAt: "2026-01-01T00:00:00.000Z",
          targetTeamIds: ["T1"],
        },
      ],
    });

    const out = await fireDisruption(shared, baseInput());
    expect(out.kind).toBe("duplicate");
    if (out.kind !== "duplicate") return;
    expect(out.result.auditId).toBe("01HPRIOR");
    // EventBridge は呼ばれない (= side effect 重複防止)
    expect(eventsSend).not.toHaveBeenCalled();
    // DDB Put も呼ばれない
    const puts = ddbSend.mock.calls.filter((c) => c[0] instanceof PutCommand);
    expect(puts).toHaveLength(0);
  });

  it("no_targets を返すべき (event 配下に team 不在)", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [] });
    ddbSend.mockResolvedValueOnce({ Items: [] });
    const out = await fireDisruption(shared, baseInput());
    expect(out.kind).toBe("no_targets");
  });

  it("audit row に parameters / firedBy / scope / requestId が書かれる", async () => {
    const { shared, ddbSend, eventsSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [] });
    ddbSend.mockResolvedValueOnce({ Items: [{ teamId: "T1" }] });
    eventsSend.mockResolvedValueOnce({});
    ddbSend.mockResolvedValueOnce({});
    ddbSend.mockResolvedValueOnce({});

    await fireDisruption(shared, baseInput({ parameters: { throttleRps: 10 } }));
    const putCmds = ddbSend.mock.calls
      .map((c) => c[0])
      .filter((c): c is PutCommand => c instanceof PutCommand);
    expect(putCmds).toHaveLength(2);
    const auditItem = putCmds[0]?.input.Item;
    expect(auditItem?.firedBy).toBe("cognito-sub-1");
    expect(auditItem?.requestId).toBe("req-12345678");
    expect(auditItem?.scope).toBe("all");
    // base parameters と merge されている (throttleRps を override + durationSec は base から継承)
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

  it("event の problems[] に該当する disruption のみを catalog に出すべき", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Item: {
        problems: [{ problemId: "battle-1" }, { problemId: "unknown-problem" }],
      },
    });
    const out = await listDisruptionCatalog(shared, "EV1");
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0]?.problemId).toBe("battle-1");
    expect(out.entries[0]?.disruption.id).toBe("router-throttle");
    // unknown-problem は problemsDisruptions に無いので skip
    expect(ddbSend.mock.calls[0]?.[0]).toBeInstanceOf(GetCommand);
  });
});
