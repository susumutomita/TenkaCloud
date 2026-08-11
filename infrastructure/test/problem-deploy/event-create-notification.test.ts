import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createNotification } from "../../lib/problem-deploy/handlers/event-handler/create-notification";
import type { EventSharedResources } from "../../lib/problem-deploy/handlers/event-handler/shared";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers";

const TENANT_ID = "tenant-acme";
const EVENT_ID = "01HZX0K3M3K9ZQHB3MRQHBA1B2";
const NOW_MS = new Date("2026-05-10T14:42:18.000Z").getTime();

function buildShared(): { shared: EventSharedResources; ddbSend: ReturnType<typeof vi.fn> } {
  const ddbSend = vi.fn();
  const shared: EventSharedResources = {
    runtime: makeTestControlDataRuntime(),
    eventsTableName: "TestEvents",
    teamsTableName: "TestTeams",
    deploymentsTableName: "TestDeployments",
    eventBusName: "TestBus",
    ddb: { send: ddbSend } as unknown as EventSharedResources["ddb"],
    events: {} as unknown as EventSharedResources["events"],
    problemsCatalog: {},
  };
  return { shared, ddbSend };
}

const eventRow = (over: Record<string, unknown> = {}) => ({
  PK: `EVENT#${EVENT_ID}`,
  SK: "META",
  eventId: EVENT_ID,
  tenantId: TENANT_ID,
  status: "READY",
  expiresAt: 1_700_000_000,
  ...over,
});

describe("createNotification", () => {
  beforeEach(() => vi.clearAllMocks());

  it("event 不在は not_found", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: undefined });
    const out = await createNotification(
      shared,
      TENANT_ID,
      EVENT_ID,
      "operator-sub-1",
      { title: "t", body: "b" },
      NOW_MS,
    );
    expect(out).toEqual({ kind: "not_found" });
    expect(ddbSend).toHaveBeenCalledTimes(1); // PutCommand には行かない
  });

  it("tenant 不一致は not_found (= 別 tenant の event を gestures しても情報を与えない)", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: eventRow({ tenantId: "tenant-other" }) });
    const out = await createNotification(
      shared,
      TENANT_ID,
      EVENT_ID,
      "operator-sub-1",
      { title: "t", body: "b" },
      NOW_MS,
    );
    expect(out).toEqual({ kind: "not_found" });
  });

  it("正常系: PK=EVENT#<eventId> + SK=NOTIFICATION#<isoTs>#<ulid> で PutItem する", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: eventRow() });
    ddbSend.mockResolvedValueOnce({});

    const out = await createNotification(
      shared,
      TENANT_ID,
      EVENT_ID,
      "operator-sub-1",
      { title: "scoring 再開", body: "メンテ完了" },
      NOW_MS,
    );

    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.occurredAt).toBe("2026-05-10T14:42:18.000Z");

    const get = ddbSend.mock.calls[0]?.[0] as GetCommand;
    expect(get).toBeInstanceOf(GetCommand);
    expect(get.input.Key).toEqual({ PK: `EVENT#${EVENT_ID}`, SK: "META" });

    const put = ddbSend.mock.calls[1]?.[0] as PutCommand;
    expect(put).toBeInstanceOf(PutCommand);
    expect(put.input.TableName).toBe("TestEvents");
    const item = put.input.Item as {
      PK: string;
      SK: string;
      title: string;
      body: string;
      severity: string;
      tenantId: string;
      eventId: string;
      createdBy: string;
      occurredAt: string;
      expiresAt: number;
    };
    expect(item.PK).toBe(`EVENT#${EVENT_ID}`);
    expect(item.SK).toMatch(/^NOTIFICATION#2026-05-10T14:42:18\.000Z#[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(item.title).toBe("scoring 再開");
    expect(item.body).toBe("メンテ完了");
    expect(item.severity).toBe("info");
    expect(item.tenantId).toBe(TENANT_ID);
    expect(item.eventId).toBe(EVENT_ID);
    expect(item.createdBy).toBe("operator-sub-1");
    expect(item.expiresAt).toBe(1_700_000_000);
  });

  it("severity 指定 (warning) を尊重する", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: eventRow() });
    ddbSend.mockResolvedValueOnce({});

    await createNotification(
      shared,
      TENANT_ID,
      EVENT_ID,
      "op",
      { title: "メンテ予告", body: "30 分後に 5 分停止", severity: "warning" },
      NOW_MS,
    );

    const put = ddbSend.mock.calls[1]?.[0] as PutCommand;
    expect((put.input.Item as { severity: string }).severity).toBe("warning");
  });
});
