import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  listNotifications,
  NOTIFICATIONS_MAX_LIMIT,
} from "../../lib/problem-deploy/handlers/participant-handler/notifications";
import type { ParticipantSharedResources } from "../../lib/problem-deploy/handlers/participant-handler/shared";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers";

const TEAM_KEY = "KEY1";
const EVENT_ID = "01HZX0K3M3K9ZQHB3MRQHBA1B2";

function buildShared(): {
  shared: ParticipantSharedResources;
  ddbSend: ReturnType<typeof vi.fn>;
} {
  const ddbSend = vi.fn();
  const shared: ParticipantSharedResources = {
    runtime: makeTestControlDataRuntime(),
    tableName: "TestDeployments",
    eventsTableName: "TestEvents",
    ddb: { send: ddbSend } as unknown as ParticipantSharedResources["ddb"],
    problemsScoring: {},
  };
  return { shared, ddbSend };
}

const teamRow = (over: Record<string, unknown> = {}) => ({
  PK: "DEPLOYMENT#J1",
  SK: "META",
  GSI2PK: `TEAMKEY#${TEAM_KEY}`,
  jobId: "J1",
  problemId: "p1",
  eventId: EVENT_ID,
  status: "COMPLETE",
  ...over,
});

describe("listNotifications", () => {
  beforeEach(() => vi.clearAllMocks());

  it("limit が 0 / 負 / 上限超 / 非整数 は invalid_limit", async () => {
    const { shared } = buildShared();
    expect((await listNotifications(shared, TEAM_KEY, 0)).kind).toBe("invalid_limit");
    expect((await listNotifications(shared, TEAM_KEY, -1)).kind).toBe("invalid_limit");
    expect((await listNotifications(shared, TEAM_KEY, NOTIFICATIONS_MAX_LIMIT + 1)).kind).toBe(
      "invalid_limit",
    );
    expect((await listNotifications(shared, TEAM_KEY, 1.5)).kind).toBe("invalid_limit");
  });

  it("teamLoginKey 不正 (deployment 0 件) は unauthorized", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [] });
    expect((await listNotifications(shared, TEAM_KEY, 50)).kind).toBe("unauthorized");
  });

  it("旧 jobId-based deployment (eventId 無し) は no_event を返す", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Items: [teamRow({ eventId: undefined })],
    });
    expect((await listNotifications(shared, TEAM_KEY, 50)).kind).toBe("no_event");
  });

  it("正常系: PK=EVENT#<eventId> + begins_with(SK, NOTIFICATION#) で降順 Query", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [teamRow()] });
    ddbSend.mockResolvedValueOnce({
      Items: [
        {
          notificationId: "01J0NEW",
          title: "新しい",
          body: "本文 1",
          severity: "info",
          occurredAt: "2026-05-10T14:42:00.000Z",
        },
        {
          notificationId: "01J0OLD",
          title: "古い",
          body: "本文 2",
          severity: "warning",
          occurredAt: "2026-05-10T13:00:00.000Z",
        },
      ],
    });

    const out = await listNotifications(shared, TEAM_KEY, 50);
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.response.eventId).toBe(EVENT_ID);
    expect(out.response.items).toHaveLength(2);
    expect(out.response.items[0]?.title).toBe("新しい");
    expect(out.response.items[1]?.severity).toBe("warning");

    const q = ddbSend.mock.calls[1]?.[0] as QueryCommand;
    expect(q).toBeInstanceOf(QueryCommand);
    expect(q.input.TableName).toBe("TestEvents");
    expect(q.input.KeyConditionExpression).toContain("PK = :pk");
    expect(q.input.KeyConditionExpression).toContain("begins_with(SK, :prefix)");
    expect(q.input.ExpressionAttributeValues?.[":pk"]).toBe(`EVENT#${EVENT_ID}`);
    expect(q.input.ExpressionAttributeValues?.[":prefix"]).toBe("NOTIFICATION#");
    expect(q.input.ScanIndexForward).toBe(false); // 降順
    expect(q.input.Limit).toBe(50);
  });

  it("response shape: tenantId / createdBy / 内部 PK/SK は出力に含めない (D1 漏洩防止)", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [teamRow()] });
    ddbSend.mockResolvedValueOnce({
      Items: [
        {
          PK: `EVENT#${EVENT_ID}`,
          SK: `NOTIFICATION#2026-05-10T14:42:00.000Z#01J0`,
          notificationId: "01J0",
          tenantId: "TENANT_LEAK_SENTINEL",
          eventId: EVENT_ID,
          createdBy: "OPERATOR_SUB_LEAK_SENTINEL",
          title: "t",
          body: "b",
          severity: "info",
          occurredAt: "2026-05-10T14:42:00.000Z",
          expiresAt: 1_700_000_000,
        },
      ],
    });

    const out = await listNotifications(shared, TEAM_KEY, 50);
    if (out.kind === "ok") {
      const json = JSON.stringify(out.response);
      expect(json).not.toContain("TENANT_LEAK_SENTINEL");
      expect(json).not.toContain("OPERATOR_SUB_LEAK_SENTINEL");
      expect(json).not.toContain("NOTIFICATION#"); // SK そのまま漏らさない
      expect(json).not.toContain("1700000000"); // expiresAt 漏らさない
    }
  });

  it("不正な行 (severity 不明 / title 欠落) は除外", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [teamRow()] });
    ddbSend.mockResolvedValueOnce({
      Items: [
        // 有効
        {
          notificationId: "1",
          title: "ok",
          body: "b",
          severity: "info",
          occurredAt: "2026-05-10T14:00:00.000Z",
        },
        // severity 不正
        {
          notificationId: "2",
          title: "bad",
          body: "b",
          severity: "critical",
          occurredAt: "2026-05-10T13:00:00.000Z",
        },
        // title 欠落
        {
          notificationId: "3",
          body: "b",
          severity: "info",
          occurredAt: "2026-05-10T12:00:00.000Z",
        },
      ],
    });

    const out = await listNotifications(shared, TEAM_KEY, 50);
    if (out.kind === "ok") expect(out.response.items).toHaveLength(1);
  });
});
