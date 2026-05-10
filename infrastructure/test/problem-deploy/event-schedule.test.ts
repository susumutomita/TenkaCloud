import { QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setEventSchedule } from "../../lib/problem-deploy/handlers/event-handler/schedule";
import type { EventSharedResources } from "../../lib/problem-deploy/handlers/event-handler/shared";
import { ScheduleEventRequestSchema } from "../../lib/problem-deploy/handlers/event-handler/types";

const NOW_MS = 1_700_000_000_000;
const NOW_ISO = new Date(NOW_MS).toISOString();
const STARTS_AT = "2026-05-08T10:00:00.000Z";

function buildShared(): {
  shared: EventSharedResources;
  ddbSend: ReturnType<typeof vi.fn>;
} {
  const ddbSend = vi.fn();
  const shared: EventSharedResources = {
    eventsTableName: "TestEvents",
    teamsTableName: "TestTeams",
    deploymentsTableName: "TestDeployments",
    eventBusName: "test-bus",
    ddb: { send: ddbSend } as unknown as EventSharedResources["ddb"],
    events: { send: vi.fn() } as unknown as EventSharedResources["events"],
    problemsCatalog: {},
  };
  return { shared, ddbSend };
}

describe("setEventSchedule", () => {
  beforeEach(() => vi.clearAllMocks());

  it("正常系: Event 行 + 紐づく全 deployment 行の eventStartsAt を更新するべき", async () => {
    const { shared, ddbSend } = buildShared();
    // 1st: Event UpdateCommand returns Attributes (= 行が存在 + tenantId 一致)
    ddbSend.mockResolvedValueOnce({
      Attributes: {
        eventId: "EV1",
        tenantId: "tenant-acme",
        startsAt: STARTS_AT,
      },
    });
    // 2nd: Deployments QueryCommand (FilterExpression で EV1 のみ server 側で除外済み)
    ddbSend.mockResolvedValueOnce({
      Items: [
        { PK: "DEPLOYMENT#J1", eventId: "EV1" },
        { PK: "DEPLOYMENT#J2", eventId: "EV1" },
        { PK: "DEPLOYMENT#J4", eventId: "EV1" },
      ],
    });
    // 3rd-5th: Deployments UpdateCommand × 3
    ddbSend.mockResolvedValue({});

    const out = await setEventSchedule(shared, "tenant-acme", "EV1", STARTS_AT, NOW_MS);
    expect(out).toEqual({ kind: "ok", startsAt: STARTS_AT, updatedDeployments: 3 });

    // Event 更新の ConditionExpression が tenantId 一致を要求する
    const eventUpd = ddbSend.mock.calls[0]?.[0] as UpdateCommand;
    expect(eventUpd).toBeInstanceOf(UpdateCommand);
    expect(eventUpd.input.ConditionExpression).toBe("tenantId = :tenantId");
    expect(eventUpd.input.ExpressionAttributeValues?.[":tenantId"]).toBe("tenant-acme");
    expect(eventUpd.input.ExpressionAttributeValues?.[":startsAt"]).toBe(STARTS_AT);

    // Deployments query は GSI1 = TENANT# + FilterExpression で eventId 一致 (cross-event 漏洩防止)
    const queryCmd = ddbSend.mock.calls[1]?.[0] as QueryCommand;
    expect(queryCmd).toBeInstanceOf(QueryCommand);
    expect(queryCmd.input.IndexName).toBe("GSI1");
    expect(queryCmd.input.ExpressionAttributeValues?.[":pk"]).toBe("TENANT#tenant-acme");
    expect(queryCmd.input.FilterExpression).toBe("eventId = :ev");
    expect(queryCmd.input.ExpressionAttributeValues?.[":ev"]).toBe("EV1");

    // Deployment update が EV1 行 3 件のみ走る
    const updCmds = ddbSend.mock.calls
      .map((c) => c[0])
      .filter((c, i): c is UpdateCommand => i > 0 && c instanceof UpdateCommand);
    expect(updCmds).toHaveLength(3);
    const updatedPks = updCmds.map((c) => (c.input.Key as { PK: string }).PK).sort();
    expect(updatedPks).toEqual(["DEPLOYMENT#J1", "DEPLOYMENT#J2", "DEPLOYMENT#J4"]);
    for (const cmd of updCmds) {
      expect(cmd.input.ExpressionAttributeValues?.[":s"]).toBe(STARTS_AT);
    }
  });

  it("Event 行不在 / tenant 不一致は ConditionalCheckFailedException → not_found", async () => {
    const { shared, ddbSend } = buildShared();
    const err = new Error("conditional failed");
    err.name = "ConditionalCheckFailedException";
    ddbSend.mockRejectedValueOnce(err);

    const out = await setEventSchedule(shared, "tenant-acme", "EV1", STARTS_AT, NOW_MS);
    expect(out).toEqual({ kind: "not_found" });
    // Deployments query / update は 1 度も走らない (= 漏洩防止)
    expect(ddbSend).toHaveBeenCalledTimes(1);
  });

  it("対象 deployment が 0 件でも ok を返し updatedDeployments=0 (= 即座に schedule のみの shortcut)", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Attributes: { eventId: "EV1", tenantId: "tenant-acme", startsAt: STARTS_AT },
    });
    ddbSend.mockResolvedValueOnce({ Items: [] });

    const out = await setEventSchedule(shared, "tenant-acme", "EV1", STARTS_AT, NOW_MS);
    expect(out).toEqual({ kind: "ok", startsAt: STARTS_AT, updatedDeployments: 0 });
    // Deployment Update は走らない (Promise.all([]))
    const updCmds = ddbSend.mock.calls
      .map((c) => c[0])
      .filter((c, i): c is UpdateCommand => i > 0 && c instanceof UpdateCommand);
    expect(updCmds).toHaveLength(0);
  });

  it("startsAt が now - 60s より過去なら past_starts_at で DDB に触れず reject すべき (#537)", async () => {
    const { shared, ddbSend } = buildShared();
    // NOW_MS の 5 分前 (= SLACK 60s より十分過去)
    const pastStartsAt = new Date(NOW_MS - 5 * 60_000).toISOString();
    const out = await setEventSchedule(shared, "tenant-acme", "EV1", pastStartsAt, NOW_MS);
    expect(out).toEqual({ kind: "past_starts_at", startsAt: pastStartsAt, nowMs: NOW_MS });
    // DDB call は 0 (= 過去日時 reject は DDB 触れない、副作用なし)
    expect(ddbSend).not.toHaveBeenCalled();
  });

  it("startsAt が now - 30s (= SLACK 内) なら過去扱いせず通すべき (#537 clock skew tolerance)", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Attributes: { eventId: "EV1", tenantId: "tenant-acme", startsAt: NOW_ISO },
    });
    ddbSend.mockResolvedValueOnce({ Items: [] });
    const slackOk = new Date(NOW_MS - 30_000).toISOString();
    const out = await setEventSchedule(shared, "tenant-acme", "EV1", slackOk, NOW_MS);
    expect(out.kind).toBe("ok");
  });

  it("Event 更新 + 全 deployment update の updatedAt は同じ now 値を使うべき", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({
      Attributes: { eventId: "EV1", tenantId: "tenant-acme", startsAt: STARTS_AT },
    });
    ddbSend.mockResolvedValueOnce({
      Items: [{ PK: "DEPLOYMENT#J1", eventId: "EV1" }],
    });
    ddbSend.mockResolvedValue({});

    await setEventSchedule(shared, "tenant-acme", "EV1", STARTS_AT, NOW_MS);
    const eventUpd = ddbSend.mock.calls[0]?.[0] as UpdateCommand;
    const deployUpd = ddbSend.mock.calls[2]?.[0] as UpdateCommand;
    expect(eventUpd.input.ExpressionAttributeValues?.[":now"]).toBe(NOW_ISO);
    expect(deployUpd.input.ExpressionAttributeValues?.[":now"]).toBe(NOW_ISO);
  });
});

/**
 * Issue #497: timezone offset の Zod 厳格化。
 * `+09:00` 等の non-Z オフセットも入力では受理するが、出力は必ず Z 形式に正規化する
 * (= 辞書順 ISO 8601 比較を HealthCheck の isScoringActive で安全に使うため)。
 */
describe("ScheduleEventRequestSchema (Issue #497)", () => {
  it("Z 終端の ISO 8601 はそのまま受理されるべき (= 既存挙動維持)", () => {
    const out = ScheduleEventRequestSchema.parse({ startsAt: "2026-05-08T10:00:00.000Z" });
    if (!("startsAt" in out)) throw new Error("startsAt 分岐になるはず");
    expect(out.startsAt).toBe("2026-05-08T10:00:00.000Z");
  });

  it("`+09:00` オフセットは UTC Z に transform されるべき", () => {
    const out = ScheduleEventRequestSchema.parse({ startsAt: "2026-05-08T19:00:00+09:00" });
    if (!("startsAt" in out)) throw new Error("startsAt 分岐になるはず");
    // JST 19:00 = UTC 10:00
    expect(out.startsAt).toBe("2026-05-08T10:00:00.000Z");
  });

  it("`-12:00` オフセットも UTC Z に transform されるべき (= 全 timezone を 1 形式に揃える)", () => {
    const out = ScheduleEventRequestSchema.parse({ startsAt: "2026-05-08T22:00:00-12:00" });
    if (!("startsAt" in out)) throw new Error("startsAt 分岐になるはず");
    // -12:00 22:00 = UTC 翌日 10:00
    expect(out.startsAt).toBe("2026-05-09T10:00:00.000Z");
  });

  it("オフセット無し (= naive) は reject (Zod datetime のデフォルト挙動)", () => {
    const result = ScheduleEventRequestSchema.safeParse({
      startsAt: "2026-05-08T10:00:00",
    });
    expect(result.success).toBe(false);
  });

  it("不正な ISO 8601 文字列は reject", () => {
    expect(ScheduleEventRequestSchema.safeParse({ startsAt: "not-a-date" }).success).toBe(false);
    expect(ScheduleEventRequestSchema.safeParse({ startsAt: "2026-13-50" }).success).toBe(false);
  });

  it("`{ startNow: true }` は transform 対象外でそのまま通る", () => {
    const out = ScheduleEventRequestSchema.parse({ startNow: true });
    expect(out).toEqual({ startNow: true });
  });

  it("正規化後の値は辞書順比較が時系列順と一致するべき (Issue #497 root cause)", () => {
    // `+12:00` 早朝 と `Z` 同日午前: 元の文字列で比べると "Z" > "+" なので壊れる
    const tzPlus = ScheduleEventRequestSchema.parse({
      startsAt: "2026-05-08T12:00:00+12:00", // = UTC 00:00
    });
    const utc = ScheduleEventRequestSchema.parse({
      startsAt: "2026-05-08T05:00:00.000Z",
    });
    if (!("startsAt" in tzPlus) || !("startsAt" in utc)) throw new Error("分岐エラー");
    // 正規化後は両方 Z 形式 → 辞書順 = 時系列順
    expect(tzPlus.startsAt < utc.startsAt).toBe(true);
    expect(tzPlus.startsAt).toBe("2026-05-08T00:00:00.000Z");
    expect(utc.startsAt).toBe("2026-05-08T05:00:00.000Z");
  });
});
