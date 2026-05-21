import { PutCommand, type QueryCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  castEvent,
  INBOX_SINCE_MS_MAX,
  readInbox,
  validateKind,
  validatePayload,
} from "../../lib/problem-deploy/handlers/participant-handler/cast-event";
import type { ParticipantSharedResources } from "../../lib/problem-deploy/handlers/participant-handler/shared";

/**
 * Inter-team event dispatch primitive の挙動を pin する unit test。
 * 認可 (同 event 縛り) / 入力 validation / DDB Put / DDB Query 結果整形を網羅する。
 */

const SENDER_JOB = "01HZX0K3M3K9ZQHB3MRQHBA1B2";
const TARGET_JOB = "01HZX0K3M3K9ZQHB3MRQHBA1B3";
const TEAM_KEY = "SENDER_KEY";
const EVENT_ID = "01HZX0E000000000000000000Z";
const NOW_MS = new Date("2026-05-21T12:00:00.000Z").getTime();

function buildShared(): { shared: ParticipantSharedResources; ddbSend: ReturnType<typeof vi.fn> } {
  const ddbSend = vi.fn();
  const shared: ParticipantSharedResources = {
    tableName: "TestDeployments",
    eventsTableName: "TestEvents",
    endpointsTableName: "",
    ddb: { send: ddbSend } as unknown as ParticipantSharedResources["ddb"],
    problemsScoring: {},
    problemsEndpoints: {},
  };
  return { shared, ddbSend };
}

const senderRow = (over: Record<string, unknown> = {}) => ({
  PK: `DEPLOYMENT#${SENDER_JOB}`,
  SK: "META",
  GSI2PK: `TEAMKEY#${TEAM_KEY}`,
  jobId: SENDER_JOB,
  teamId: "team-alpha",
  eventId: EVENT_ID,
  status: "COMPLETE",
  ...over,
});

const targetMetaRow = (over: Record<string, unknown> = {}) => ({
  PK: `DEPLOYMENT#${TARGET_JOB}`,
  SK: "META",
  jobId: TARGET_JOB,
  teamId: "team-beta",
  eventId: EVENT_ID,
  status: "COMPLETE",
  ...over,
});

describe("validateKind", () => {
  it("should accept lowercase kebab-case kinds", () => {
    expect(validateKind("attack-launch")).toBe(true);
    expect(validateKind("a")).toBe(true);
  });

  it("should reject UPPERCASE / spaces / leading-digit / non-string", () => {
    expect(validateKind("Attack-Launch")).toBe(false);
    expect(validateKind("attack launch")).toBe(false);
    expect(validateKind("1invalid")).toBe(false);
    expect(validateKind(42)).toBe(false);
    expect(validateKind(undefined)).toBe(false);
  });

  it("should reject kinds longer than 64 chars", () => {
    expect(validateKind("a".repeat(65))).toBe(false);
    expect(validateKind("a".repeat(64))).toBe(true);
  });
});

describe("validatePayload", () => {
  it("should accept undefined / null / objects up to 4 KB", () => {
    expect(validatePayload(undefined)).toBe(true);
    expect(validatePayload(null)).toBe(true);
    expect(validatePayload({ foo: "bar" })).toBe(true);
  });

  it("should reject primitives that are not null", () => {
    expect(validatePayload("string")).toBe(false);
    expect(validatePayload(123)).toBe(false);
  });

  it("should reject payloads larger than 4 KB", () => {
    const big = { blob: "x".repeat(5_000) };
    expect(validatePayload(big)).toBe(false);
  });
});

describe("castEvent", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should return invalid_jobid for non-ULID targetJobId", async () => {
    const { shared } = buildShared();
    const out = await castEvent(shared, TEAM_KEY, {
      targetJobId: "not-ulid",
      kind: "attack",
      payload: {},
    });
    expect(out).toEqual({ kind: "invalid_jobid" });
  });

  it("should return invalid_kind for malformed kind", async () => {
    const { shared } = buildShared();
    const out = await castEvent(shared, TEAM_KEY, {
      targetJobId: TARGET_JOB,
      kind: "BAD KIND",
      payload: {},
    });
    expect(out).toEqual({ kind: "invalid_kind" });
  });

  it("should return invalid_payload when payload exceeds 4 KB", async () => {
    const { shared } = buildShared();
    const out = await castEvent(shared, TEAM_KEY, {
      targetJobId: TARGET_JOB,
      kind: "attack",
      payload: { blob: "x".repeat(5_000) },
    });
    expect(out).toEqual({ kind: "invalid_payload" });
  });

  it("should return unauthorized when caller's teamLoginKey has no deployments", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [] });
    const out = await castEvent(shared, TEAM_KEY, {
      targetJobId: TARGET_JOB,
      kind: "attack",
      payload: {},
    });
    expect(out).toEqual({ kind: "unauthorized" });
  });

  it("should return not_ready when sender has only PENDING / IN_PROGRESS deployments", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [senderRow({ status: "PENDING" })] });
    const out = await castEvent(shared, TEAM_KEY, {
      targetJobId: TARGET_JOB,
      kind: "attack",
      payload: {},
    });
    expect(out).toEqual({ kind: "not_ready" });
  });

  it("should return target_not_found when target deployment does not exist", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [senderRow()] });
    ddbSend.mockResolvedValueOnce({ Items: [] });
    const out = await castEvent(shared, TEAM_KEY, {
      targetJobId: TARGET_JOB,
      kind: "attack",
      payload: {},
    });
    expect(out).toEqual({ kind: "target_not_found" });
  });

  it("should return target_not_found when target deployment is DELETED", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [senderRow()] });
    ddbSend.mockResolvedValueOnce({ Items: [targetMetaRow({ status: "DELETED" })] });
    const out = await castEvent(shared, TEAM_KEY, {
      targetJobId: TARGET_JOB,
      kind: "attack",
      payload: {},
    });
    expect(out).toEqual({ kind: "target_not_found" });
  });

  it("should return cross_event_forbidden when target is in a different event", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [senderRow()] });
    ddbSend.mockResolvedValueOnce({
      Items: [targetMetaRow({ eventId: "01HZX0E000000000000000DIFF" })],
    });
    const out = await castEvent(shared, TEAM_KEY, {
      targetJobId: TARGET_JOB,
      kind: "attack",
      payload: {},
    });
    expect(out).toEqual({ kind: "cross_event_forbidden" });
  });

  it("should Put an INBOX# row on the target deployment partition with ttl + sender context (= happy path)", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [senderRow()] });
    ddbSend.mockResolvedValueOnce({ Items: [targetMetaRow()] });
    ddbSend.mockResolvedValueOnce({});
    const out = await castEvent(shared, TEAM_KEY, {
      targetJobId: TARGET_JOB,
      kind: "attack-launch",
      payload: { damage: 30 },
    });
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.eventId).toMatch(/^[0-9A-Z]{26}$/);
    expect(out.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

    const putCall = ddbSend.mock.calls.find(([cmd]) => cmd instanceof PutCommand);
    expect(putCall).toBeDefined();
    const input = (putCall?.[0] as PutCommand).input as {
      TableName: string;
      Item: Record<string, unknown>;
    };
    expect(input.TableName).toBe("TestDeployments");
    expect(input.Item.PK).toBe(`DEPLOYMENT#${TARGET_JOB}`);
    expect((input.Item.SK as string).startsWith("INBOX#")).toBe(true);
    expect(input.Item.fromTeamId).toBe("team-alpha");
    expect(input.Item.fromJobId).toBe(SENDER_JOB);
    expect(input.Item.eventId).toBe(EVENT_ID);
    expect(input.Item.kind).toBe("attack-launch");
    expect(input.Item.payload).toEqual({ damage: 30 });
    expect(typeof input.Item.ttl).toBe("number");
    // TTL は ~7 日 + 現在時刻、 6.5 日 < ttl < 7.5 日 で許容
    const ttlSec = input.Item.ttl as number;
    const nowSec = Math.floor(Date.now() / 1000);
    expect(ttlSec).toBeGreaterThan(nowSec + 6 * 24 * 60 * 60);
    expect(ttlSec).toBeLessThan(nowSec + 8 * 24 * 60 * 60);
  });
});

describe("readInbox", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should return invalid_jobid for non-ULID jobId", async () => {
    const { shared } = buildShared();
    const out = await readInbox(shared, TEAM_KEY, "not-ulid", 0, NOW_MS);
    expect(out).toEqual({ kind: "invalid_jobid" });
  });

  it("should return invalid_since_ms for negative / future / too-old / non-integer sinceMs", async () => {
    const { shared } = buildShared();
    expect((await readInbox(shared, TEAM_KEY, SENDER_JOB, -1, NOW_MS)).kind).toBe(
      "invalid_since_ms",
    );
    expect((await readInbox(shared, TEAM_KEY, SENDER_JOB, NOW_MS + 1, NOW_MS)).kind).toBe(
      "invalid_since_ms",
    );
    expect(
      (await readInbox(shared, TEAM_KEY, SENDER_JOB, NOW_MS - INBOX_SINCE_MS_MAX - 1, NOW_MS)).kind,
    ).toBe("invalid_since_ms");
    expect((await readInbox(shared, TEAM_KEY, SENDER_JOB, 1.5, NOW_MS)).kind).toBe(
      "invalid_since_ms",
    );
  });

  it("should return unauthorized when jobId is not owned by the team", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [senderRow()] });
    const out = await readInbox(shared, TEAM_KEY, TARGET_JOB, NOW_MS - 60_000, NOW_MS);
    expect(out).toEqual({ kind: "unauthorized" });
  });

  it("should return ok with events sorted newest first (= DDB Query with ScanIndexForward=false)", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Items: [senderRow()] });
    ddbSend.mockResolvedValueOnce({
      Items: [
        {
          PK: `DEPLOYMENT#${SENDER_JOB}`,
          SK: "INBOX#2026-05-21T12:01:00.000Z#01J",
          eventId: EVENT_ID,
          fromTeamId: "team-beta",
          fromJobId: TARGET_JOB,
          kind: "attack-launch",
          payload: { damage: 30 },
          occurredAt: "2026-05-21T12:01:00.000Z",
        },
        {
          PK: `DEPLOYMENT#${SENDER_JOB}`,
          SK: "INBOX#2026-05-21T12:00:30.000Z#01H",
          eventId: EVENT_ID,
          fromTeamId: "team-gamma",
          fromJobId: "01HZX0K3M3K9ZQHB3MRQHBA1B4",
          kind: "alliance-propose",
          payload: { duration: 60 },
          occurredAt: "2026-05-21T12:00:30.000Z",
        },
      ],
      LastEvaluatedKey: undefined,
    });
    const out = await readInbox(shared, TEAM_KEY, SENDER_JOB, NOW_MS - 5 * 60_000, NOW_MS);
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.events.length).toBe(2);
    expect(out.events[0]?.kind).toBe("attack-launch");
    expect(out.events[1]?.kind).toBe("alliance-propose");

    const queryCall = ddbSend.mock.calls[1];
    const input = (queryCall?.[0] as QueryCommand).input as {
      ScanIndexForward?: boolean;
      ExpressionAttributeValues?: Record<string, string>;
    };
    expect(input.ScanIndexForward).toBe(false);
    expect(input.ExpressionAttributeValues?.[":pk"]).toBe(`DEPLOYMENT#${SENDER_JOB}`);
  });
});
