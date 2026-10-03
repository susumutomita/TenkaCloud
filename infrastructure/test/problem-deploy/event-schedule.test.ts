import { GetCommand, type QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setEventSchedule } from "../../lib/problem-deploy/handlers/event-handler/schedule";
import type { EventSharedResources } from "../../lib/problem-deploy/handlers/event-handler/shared";
import { ScheduleEventRequestSchema } from "../../lib/problem-deploy/handlers/event-handler/types";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers";

const NOW_MS = 1_700_000_000_000;
const NOW_ISO = new Date(NOW_MS).toISOString();
const STARTS_AT = "2026-05-08T10:00:00.000Z";
const ENDS_AT = "2026-05-08T12:00:00.000Z";

function buildShared(): {
  shared: EventSharedResources;
  ddbSend: ReturnType<typeof vi.fn>;
} {
  const ddbSend = vi.fn();
  const shared: EventSharedResources = {
    runtime: makeTestControlDataRuntime(),
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

function mockCurrentEvent(
  ddbSend: ReturnType<typeof vi.fn>,
  item: { tenantId?: string; startsAt?: string; endsAt?: string } = { tenantId: "tenant-acme" },
) {
  ddbSend.mockResolvedValueOnce({ Item: item });
}

describe("setEventSchedule (startsAt のみ、既存パターン)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("normal case: should update eventStartsAt on the Event row and all linked deployment rows", async () => {
    const { shared, ddbSend } = buildShared();
    mockCurrentEvent(ddbSend);
    ddbSend.mockResolvedValueOnce({
      Attributes: { eventId: "EV1", tenantId: "tenant-acme", startsAt: STARTS_AT },
    });
    ddbSend.mockResolvedValueOnce({
      Items: [
        { PK: "DEPLOYMENT#J1", eventId: "EV1" },
        { PK: "DEPLOYMENT#J2", eventId: "EV1" },
        { PK: "DEPLOYMENT#J4", eventId: "EV1" },
      ],
    });
    ddbSend.mockResolvedValue({});

    const out = await setEventSchedule(shared, "tenant-acme", "EV1", {
      startsAt: STARTS_AT,
      nowMs: NOW_MS,
    });
    expect(out).toEqual({
      kind: "ok",
      startsAt: STARTS_AT,
      endsAt: undefined,
      updatedDeployments: 3,
    });

    const eventGet = ddbSend.mock.calls[0]?.[0] as GetCommand;
    expect(eventGet).toBeInstanceOf(GetCommand);

    const eventUpd = ddbSend.mock.calls[1]?.[0] as UpdateCommand;
    expect(eventUpd).toBeInstanceOf(UpdateCommand);
    expect(eventUpd.input.ConditionExpression).toBe("tenantId = :tenantId");
    expect(eventUpd.input.ExpressionAttributeValues?.[":tenantId"]).toBe("tenant-acme");
    expect(eventUpd.input.ExpressionAttributeValues?.[":startsAt"]).toBe(STARTS_AT);
    // endsAt 未指定なので update 対象に含まれない
    expect(eventUpd.input.ExpressionAttributeValues?.[":endsAt"]).toBeUndefined();

    const queryCmd = ddbSend.mock.calls[2]?.[0] as QueryCommand;
    expect(queryCmd.input.IndexName).toBe("GSI1");
    expect(queryCmd.input.ExpressionAttributeValues?.[":pk"]).toBe("TENANT#tenant-acme");
    expect(queryCmd.input.FilterExpression).toBe("eventId = :ev");

    const updCmds = ddbSend.mock.calls
      .map((c) => c[0])
      .filter((c, i): c is UpdateCommand => i > 1 && c instanceof UpdateCommand);
    expect(updCmds).toHaveLength(3);
    for (const cmd of updCmds) {
      expect(cmd.input.ExpressionAttributeValues?.[":s"]).toBe(STARTS_AT);
      expect(cmd.input.ExpressionAttributeValues?.[":e"]).toBeUndefined();
      // #872: deployment write も tenantId 一致を atomic に強制する defense-in-depth
      expect(cmd.input.ConditionExpression).toBe("tenantId = :tenantId");
      expect(cmd.input.ExpressionAttributeValues?.[":tenantId"]).toBe("tenant-acme");
    }
  });

  it("Event 行不在 / tenant 不一致は ConditionalCheckFailedException → not_found", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({});

    const out = await setEventSchedule(shared, "tenant-acme", "EV1", {
      startsAt: STARTS_AT,
      nowMs: NOW_MS,
    });
    expect(out).toEqual({ kind: "not_found" });
    expect(ddbSend).toHaveBeenCalledTimes(1);
  });

  it("対象 deployment が 0 件でも ok を返し updatedDeployments=0", async () => {
    const { shared, ddbSend } = buildShared();
    mockCurrentEvent(ddbSend);
    ddbSend.mockResolvedValueOnce({
      Attributes: { eventId: "EV1", tenantId: "tenant-acme", startsAt: STARTS_AT },
    });
    ddbSend.mockResolvedValueOnce({ Items: [] });

    const out = await setEventSchedule(shared, "tenant-acme", "EV1", {
      startsAt: STARTS_AT,
      nowMs: NOW_MS,
    });
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") expect(out.updatedDeployments).toBe(0);
  });

  it("startsAt が now - 60s より過去なら past_starts_at で DDB に触れず reject (#537)", async () => {
    const { shared, ddbSend } = buildShared();
    const pastStartsAt = new Date(NOW_MS - 5 * 60_000).toISOString();
    const out = await setEventSchedule(shared, "tenant-acme", "EV1", {
      startsAt: pastStartsAt,
      nowMs: NOW_MS,
    });
    expect(out).toEqual({ kind: "past_starts_at", startsAt: pastStartsAt, nowMs: NOW_MS });
    expect(ddbSend).not.toHaveBeenCalled();
  });

  it("should pass when startsAt is now - 30s (within SLACK) (#537 clock skew)", async () => {
    const { shared, ddbSend } = buildShared();
    mockCurrentEvent(ddbSend);
    ddbSend.mockResolvedValueOnce({
      Attributes: { eventId: "EV1", tenantId: "tenant-acme", startsAt: NOW_ISO },
    });
    ddbSend.mockResolvedValueOnce({ Items: [] });
    const slackOk = new Date(NOW_MS - 30_000).toISOString();
    const out = await setEventSchedule(shared, "tenant-acme", "EV1", {
      startsAt: slackOk,
      nowMs: NOW_MS,
    });
    expect(out.kind).toBe("ok");
  });

  it("should use the same now value for updatedAt across Event and all deployment updates", async () => {
    const { shared, ddbSend } = buildShared();
    mockCurrentEvent(ddbSend);
    ddbSend.mockResolvedValueOnce({
      Attributes: { eventId: "EV1", tenantId: "tenant-acme", startsAt: STARTS_AT },
    });
    ddbSend.mockResolvedValueOnce({ Items: [{ PK: "DEPLOYMENT#J1", eventId: "EV1" }] });
    ddbSend.mockResolvedValue({});

    await setEventSchedule(shared, "tenant-acme", "EV1", { startsAt: STARTS_AT, nowMs: NOW_MS });
    const eventUpd = ddbSend.mock.calls[1]?.[0] as UpdateCommand;
    const deployUpd = ddbSend.mock.calls[3]?.[0] as UpdateCommand;
    expect(eventUpd.input.ExpressionAttributeValues?.[":now"]).toBe(NOW_ISO);
    expect(deployUpd.input.ExpressionAttributeValues?.[":now"]).toBe(NOW_ISO);
  });
});

describe("setEventSchedule endsAt (#536 scheduled endsAt)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("endsAt のみ指定 → Event の endsAt + deployments の eventEndsAt を更新、startsAt は触らない", async () => {
    const { shared, ddbSend } = buildShared();
    mockCurrentEvent(ddbSend, { tenantId: "tenant-acme", startsAt: STARTS_AT });
    ddbSend.mockResolvedValueOnce({
      Attributes: { eventId: "EV1", tenantId: "tenant-acme", endsAt: ENDS_AT },
    });
    ddbSend.mockResolvedValueOnce({ Items: [{ PK: "DEPLOYMENT#J1", eventId: "EV1" }] });
    ddbSend.mockResolvedValue({});

    const out = await setEventSchedule(shared, "tenant-acme", "EV1", {
      endsAt: ENDS_AT,
      nowMs: NOW_MS,
    });
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") {
      expect(out.startsAt).toBeUndefined();
      expect(out.endsAt).toBe(ENDS_AT);
    }

    const eventUpd = ddbSend.mock.calls[1]?.[0] as UpdateCommand;
    expect(eventUpd.input.ExpressionAttributeValues?.[":endsAt"]).toBe(ENDS_AT);
    expect(eventUpd.input.ExpressionAttributeValues?.[":startsAt"]).toBeUndefined();

    const deployUpd = ddbSend.mock.calls[3]?.[0] as UpdateCommand;
    expect(deployUpd.input.ExpressionAttributeValues?.[":e"]).toBe(ENDS_AT);
    expect(deployUpd.input.ExpressionAttributeValues?.[":s"]).toBeUndefined();
  });

  it("should update both via a single UpdateCommand when startsAt + endsAt are both specified", async () => {
    const { shared, ddbSend } = buildShared();
    mockCurrentEvent(ddbSend);
    ddbSend.mockResolvedValueOnce({
      Attributes: {
        eventId: "EV1",
        tenantId: "tenant-acme",
        startsAt: STARTS_AT,
        endsAt: ENDS_AT,
      },
    });
    ddbSend.mockResolvedValueOnce({ Items: [{ PK: "DEPLOYMENT#J1", eventId: "EV1" }] });
    ddbSend.mockResolvedValue({});

    const out = await setEventSchedule(shared, "tenant-acme", "EV1", {
      startsAt: STARTS_AT,
      endsAt: ENDS_AT,
      nowMs: NOW_MS,
    });
    expect(out.kind).toBe("ok");

    const eventUpd = ddbSend.mock.calls[1]?.[0] as UpdateCommand;
    expect(eventUpd.input.UpdateExpression).toContain("startsAt = :startsAt");
    expect(eventUpd.input.UpdateExpression).toContain("endsAt = :endsAt");
    expect(eventUpd.input.ExpressionAttributeValues?.[":startsAt"]).toBe(STARTS_AT);
    expect(eventUpd.input.ExpressionAttributeValues?.[":endsAt"]).toBe(ENDS_AT);
  });

  it("endsAt が now - 60s より過去なら past_ends_at で DDB に触れず reject (#536)", async () => {
    const { shared, ddbSend } = buildShared();
    const pastEnds = new Date(NOW_MS - 5 * 60_000).toISOString();
    const out = await setEventSchedule(shared, "tenant-acme", "EV1", {
      endsAt: pastEnds,
      nowMs: NOW_MS,
    });
    expect(out).toEqual({ kind: "past_ends_at", endsAt: pastEnds, nowMs: NOW_MS });
    expect(ddbSend).not.toHaveBeenCalled();
  });

  it("endsAt <= startsAt は ends_before_starts で reject (#536 0 分競技を防ぐ)", async () => {
    const { shared, ddbSend } = buildShared();
    const start = "2026-05-08T10:00:00.000Z";
    const earlierEnd = "2026-05-08T09:00:00.000Z";
    const out = await setEventSchedule(shared, "tenant-acme", "EV1", {
      startsAt: start,
      endsAt: earlierEnd,
      nowMs: NOW_MS,
    });
    expect(out).toEqual({
      kind: "ends_before_starts",
      startsAt: start,
      endsAt: earlierEnd,
    });
    expect(ddbSend).not.toHaveBeenCalled();
  });

  it("should reject with ends_before_starts when only endsAt is set and is before existing startsAt (#741)", async () => {
    const { shared, ddbSend } = buildShared();
    const laterStart = "2026-05-08T13:00:00.000Z";
    mockCurrentEvent(ddbSend, { tenantId: "tenant-acme", startsAt: laterStart });

    const out = await setEventSchedule(shared, "tenant-acme", "EV1", {
      endsAt: ENDS_AT,
      nowMs: NOW_MS,
    });

    expect(out).toEqual({
      kind: "ends_before_starts",
      startsAt: laterStart,
      endsAt: ENDS_AT,
    });
    expect(ddbSend).toHaveBeenCalledTimes(1);
    expect(ddbSend.mock.calls[0]?.[0]).toBeInstanceOf(GetCommand);
  });

  it("endsAt === startsAt も ends_before_starts (= 競技時間 0 分は無効)", async () => {
    const { shared, ddbSend } = buildShared();
    const same = "2026-05-08T10:00:00.000Z";
    const out = await setEventSchedule(shared, "tenant-acme", "EV1", {
      startsAt: same,
      endsAt: same,
      nowMs: NOW_MS,
    });
    expect(out.kind).toBe("ends_before_starts");
    expect(ddbSend).not.toHaveBeenCalled();
  });

  it("startsAt も endsAt も無指定 → no_op (DDB 不触)", async () => {
    const { shared, ddbSend } = buildShared();
    const out = await setEventSchedule(shared, "tenant-acme", "EV1", { nowMs: NOW_MS });
    expect(out).toEqual({ kind: "no_op" });
    expect(ddbSend).not.toHaveBeenCalled();
  });
});

describe("setEventSchedule teardownAt (自動撤去)", () => {
  beforeEach(() => vi.clearAllMocks());
  const TEARDOWN_AT = "2026-05-08T14:00:00.000Z"; // ENDS_AT (12:00) 以降

  it("teardownAt のみ → Event の teardownAt を更新、deployments には伝播しない", async () => {
    const { shared, ddbSend } = buildShared();
    mockCurrentEvent(ddbSend, { tenantId: "tenant-acme", endsAt: ENDS_AT });
    ddbSend.mockResolvedValueOnce({
      Attributes: { eventId: "EV1", tenantId: "tenant-acme", teardownAt: TEARDOWN_AT },
    });
    ddbSend.mockResolvedValueOnce({ Items: [{ PK: "DEPLOYMENT#J1", eventId: "EV1" }] });
    ddbSend.mockResolvedValue({});

    const out = await setEventSchedule(shared, "tenant-acme", "EV1", {
      teardownAt: TEARDOWN_AT,
      nowMs: NOW_MS,
    });
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") expect(out.teardownAt).toBe(TEARDOWN_AT);

    const eventUpd = ddbSend.mock.calls[1]?.[0] as UpdateCommand;
    expect(eventUpd.input.ExpressionAttributeValues?.[":teardownAt"]).toBe(TEARDOWN_AT);
    const deployUpd = ddbSend.mock.calls[3]?.[0] as UpdateCommand;
    // teardownAt は event-level のみ (= deployment へ非伝播)
    expect(deployUpd.input.ExpressionAttributeValues?.[":teardownAt"]).toBeUndefined();
  });

  it("teardownAt が now - 60s より過去なら past_teardown_at で DDB 不触", async () => {
    const { shared, ddbSend } = buildShared();
    const past = new Date(NOW_MS - 5 * 60_000).toISOString();
    const out = await setEventSchedule(shared, "tenant-acme", "EV1", {
      teardownAt: past,
      nowMs: NOW_MS,
    });
    expect(out).toEqual({ kind: "past_teardown_at", teardownAt: past, nowMs: NOW_MS });
    expect(ddbSend).not.toHaveBeenCalled();
  });

  it("teardownAt < endsAt (同 request) は teardown_before_ends で DDB 不触", async () => {
    const { shared, ddbSend } = buildShared();
    const earlier = "2026-05-08T11:00:00.000Z"; // ENDS_AT (12:00) より前
    const out = await setEventSchedule(shared, "tenant-acme", "EV1", {
      endsAt: ENDS_AT,
      teardownAt: earlier,
      nowMs: NOW_MS,
    });
    expect(out).toEqual({ kind: "teardown_before_ends", teardownAt: earlier, endsAt: ENDS_AT });
    expect(ddbSend).not.toHaveBeenCalled();
  });

  it("teardownAt 単独 < 既存 endsAt は teardown_before_ends (GetCommand 1 回、post-fetch)", async () => {
    const { shared, ddbSend } = buildShared();
    mockCurrentEvent(ddbSend, { tenantId: "tenant-acme", endsAt: ENDS_AT });
    const earlier = "2026-05-08T11:00:00.000Z";
    const out = await setEventSchedule(shared, "tenant-acme", "EV1", {
      teardownAt: earlier,
      nowMs: NOW_MS,
    });
    expect(out).toEqual({ kind: "teardown_before_ends", teardownAt: earlier, endsAt: ENDS_AT });
    expect(ddbSend).toHaveBeenCalledTimes(1);
  });

  it("teardownAt === endsAt は許容 (>= 不変条件)", async () => {
    const { shared, ddbSend } = buildShared();
    mockCurrentEvent(ddbSend, { tenantId: "tenant-acme", endsAt: ENDS_AT });
    ddbSend.mockResolvedValueOnce({
      Attributes: { eventId: "EV1", tenantId: "tenant-acme", teardownAt: ENDS_AT },
    });
    ddbSend.mockResolvedValueOnce({ Items: [] });
    const out = await setEventSchedule(shared, "tenant-acme", "EV1", {
      teardownAt: ENDS_AT,
      nowMs: NOW_MS,
    });
    expect(out.kind).toBe("ok");
  });

  it("endsAt 不在の event でも teardownAt 単独設定は許容 (= 「いつか撤去」予約)", async () => {
    const { shared, ddbSend } = buildShared();
    mockCurrentEvent(ddbSend, { tenantId: "tenant-acme" });
    ddbSend.mockResolvedValueOnce({
      Attributes: { eventId: "EV1", tenantId: "tenant-acme", teardownAt: TEARDOWN_AT },
    });
    ddbSend.mockResolvedValueOnce({ Items: [] });
    const out = await setEventSchedule(shared, "tenant-acme", "EV1", {
      teardownAt: TEARDOWN_AT,
      nowMs: NOW_MS,
    });
    expect(out.kind).toBe("ok");
  });
});

describe("setEventSchedule deployAt (自動デプロイ)", () => {
  beforeEach(() => vi.clearAllMocks());
  const DEPLOY_AT = "2026-05-08T09:00:00.000Z"; // ENDS_AT (12:00) 以前

  it("deployAt のみ → Event の deployAt を更新、deployments には伝播しない", async () => {
    const { shared, ddbSend } = buildShared();
    mockCurrentEvent(ddbSend, { tenantId: "tenant-acme", endsAt: ENDS_AT });
    ddbSend.mockResolvedValueOnce({
      Attributes: { eventId: "EV1", tenantId: "tenant-acme", deployAt: DEPLOY_AT },
    });
    ddbSend.mockResolvedValueOnce({ Items: [{ PK: "DEPLOYMENT#J1", eventId: "EV1" }] });
    ddbSend.mockResolvedValue({});

    const out = await setEventSchedule(shared, "tenant-acme", "EV1", {
      deployAt: DEPLOY_AT,
      nowMs: NOW_MS,
    });
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") expect(out.deployAt).toBe(DEPLOY_AT);

    const eventUpd = ddbSend.mock.calls[1]?.[0] as UpdateCommand;
    expect(eventUpd.input.UpdateExpression).toContain("deployAt = :deployAt");
    expect(eventUpd.input.ExpressionAttributeValues?.[":deployAt"]).toBe(DEPLOY_AT);
    const deployUpd = ddbSend.mock.calls[3]?.[0] as UpdateCommand;
    // deployAt は event-level のみ (= deployment へ非伝播)
    expect(deployUpd.input.ExpressionAttributeValues?.[":deployAt"]).toBeUndefined();
  });

  it("deployAt が now - 60s より過去なら past_deploy_at で DDB 不触", async () => {
    const { shared, ddbSend } = buildShared();
    const past = new Date(NOW_MS - 5 * 60_000).toISOString();
    const out = await setEventSchedule(shared, "tenant-acme", "EV1", {
      deployAt: past,
      nowMs: NOW_MS,
    });
    expect(out).toEqual({ kind: "past_deploy_at", deployAt: past, nowMs: NOW_MS });
    expect(ddbSend).not.toHaveBeenCalled();
  });

  it("deployAt > endsAt (同 request) は deploy_after_ends で DDB 不触", async () => {
    const { shared, ddbSend } = buildShared();
    const later = "2026-05-08T13:00:00.000Z"; // ENDS_AT (12:00) より後
    const out = await setEventSchedule(shared, "tenant-acme", "EV1", {
      endsAt: ENDS_AT,
      deployAt: later,
      nowMs: NOW_MS,
    });
    expect(out).toEqual({ kind: "deploy_after_ends", deployAt: later, endsAt: ENDS_AT });
    expect(ddbSend).not.toHaveBeenCalled();
  });

  it("deployAt 単独 > 既存 endsAt は deploy_after_ends (GetCommand 1 回、post-fetch)", async () => {
    const { shared, ddbSend } = buildShared();
    mockCurrentEvent(ddbSend, { tenantId: "tenant-acme", endsAt: ENDS_AT });
    const later = "2026-05-08T13:00:00.000Z";
    const out = await setEventSchedule(shared, "tenant-acme", "EV1", {
      deployAt: later,
      nowMs: NOW_MS,
    });
    expect(out).toEqual({ kind: "deploy_after_ends", deployAt: later, endsAt: ENDS_AT });
    expect(ddbSend).toHaveBeenCalledTimes(1);
  });

  it("deployAt === endsAt は許容 (<= 不変条件)", async () => {
    const { shared, ddbSend } = buildShared();
    mockCurrentEvent(ddbSend, { tenantId: "tenant-acme", endsAt: ENDS_AT });
    ddbSend.mockResolvedValueOnce({
      Attributes: { eventId: "EV1", tenantId: "tenant-acme", deployAt: ENDS_AT },
    });
    ddbSend.mockResolvedValueOnce({ Items: [] });
    const out = await setEventSchedule(shared, "tenant-acme", "EV1", {
      deployAt: ENDS_AT,
      nowMs: NOW_MS,
    });
    expect(out.kind).toBe("ok");
  });

  it("endsAt 不在の event でも deployAt 単独設定は許容 (= 「いつか deploy」予約)", async () => {
    const { shared, ddbSend } = buildShared();
    mockCurrentEvent(ddbSend, { tenantId: "tenant-acme" });
    ddbSend.mockResolvedValueOnce({
      Attributes: { eventId: "EV1", tenantId: "tenant-acme", deployAt: DEPLOY_AT },
    });
    ddbSend.mockResolvedValueOnce({ Items: [] });
    const out = await setEventSchedule(shared, "tenant-acme", "EV1", {
      deployAt: DEPLOY_AT,
      nowMs: NOW_MS,
    });
    expect(out.kind).toBe("ok");
  });
});

/**
 * Issue #497 + #536: ScheduleEventRequestSchema の shape を pin。
 * - `+09:00` 等の non-Z オフセットは UTC Z に transform される (= 辞書順比較の安全性)
 * - startsAt / startNow / endsAt の組み合わせ refinement
 */
describe("ScheduleEventRequestSchema", () => {
  it("should accept Z-terminated ISO 8601 as-is", () => {
    const out = ScheduleEventRequestSchema.parse({ startsAt: "2026-05-08T10:00:00.000Z" });
    expect(out.startsAt).toBe("2026-05-08T10:00:00.000Z");
  });

  it("should transform a `+09:00` offset to UTC Z", () => {
    const out = ScheduleEventRequestSchema.parse({ startsAt: "2026-05-08T19:00:00+09:00" });
    expect(out.startsAt).toBe("2026-05-08T10:00:00.000Z");
  });

  it("endsAt should likewise transform its offset to Z (#536)", () => {
    const out = ScheduleEventRequestSchema.parse({ endsAt: "2026-05-08T21:00:00+09:00" });
    expect(out.endsAt).toBe("2026-05-08T12:00:00.000Z");
  });

  it("teardownAt should also transform its offset to Z", () => {
    const out = ScheduleEventRequestSchema.parse({ teardownAt: "2026-05-08T23:00:00+09:00" });
    expect(out.teardownAt).toBe("2026-05-08T14:00:00.000Z");
  });

  it("deployAt should also transform its offset to Z", () => {
    const out = ScheduleEventRequestSchema.parse({ deployAt: "2026-05-08T18:00:00+09:00" });
    expect(out.deployAt).toBe("2026-05-08T09:00:00.000Z");
  });

  it("`{ deployAt }` のみで refine を通る", () => {
    const out = ScheduleEventRequestSchema.parse({ deployAt: "2026-05-08T09:00:00.000Z" });
    expect(out.deployAt).toBe("2026-05-08T09:00:00.000Z");
  });

  it("`{ teardownAt }` のみで refine を通る", () => {
    const out = ScheduleEventRequestSchema.parse({ teardownAt: "2026-05-08T14:00:00.000Z" });
    expect(out.teardownAt).toBe("2026-05-08T14:00:00.000Z");
  });

  it("オフセット無し (naive) は reject", () => {
    expect(ScheduleEventRequestSchema.safeParse({ startsAt: "2026-05-08T10:00:00" }).success).toBe(
      false,
    );
  });

  it("`{ startNow: true }` のみで通る (既存 UX 互換)", () => {
    const out = ScheduleEventRequestSchema.parse({ startNow: true });
    expect(out.startNow).toBe(true);
  });

  it("`{ startNow: true, endsAt: ... }` は startNow + 終了予約の組み合わせ (#536)", () => {
    const out = ScheduleEventRequestSchema.parse({
      startNow: true,
      endsAt: "2026-05-08T12:00:00.000Z",
    });
    expect(out.startNow).toBe(true);
    expect(out.endsAt).toBe("2026-05-08T12:00:00.000Z");
  });

  it("startsAt と startNow の同時指定は refinement で reject", () => {
    const result = ScheduleEventRequestSchema.safeParse({
      startsAt: "2026-05-08T10:00:00.000Z",
      startNow: true,
    });
    expect(result.success).toBe(false);
  });

  it("startsAt / startNow / endsAt のいずれも未指定は refinement で reject", () => {
    const result = ScheduleEventRequestSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});
