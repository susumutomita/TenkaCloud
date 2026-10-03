import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isEventOwnedByTenant,
  listDisruptionAudit,
  listDisruptionCatalog,
} from "../../lib/problem-deploy/handlers/event-handler/disruption-fire";
import type { EventSharedResources } from "../../lib/problem-deploy/handlers/event-handler/shared";
import { makeTestControlDataRuntime } from "./control-data/runtime.test-helpers";

/**
 * Issue #1418: disruption-fire.ts の read 系 (isEventOwnedByTenant / listDisruptionAudit /
 * listDisruptionCatalog) を pin する。 cursor decode の全 reject 枝、 audit row の field default、
 * pagination、 catalog merge の guard を網羅する。fireDisruption mutation は専用 test で扱う。
 */
const cfg = {
  eventItem: undefined as Record<string, unknown> | undefined,
  auditItems: [] as Record<string, unknown>[] | undefined,
  auditLastKey: undefined as Record<string, unknown> | undefined,
};
const ddb = {
  // biome-ignore lint/suspicious/noExplicitAny: fake dispatches by command + TableName.
  send: vi.fn(async (cmd: any) => {
    if (cmd instanceof GetCommand) return { Item: cfg.eventItem };
    if (cmd instanceof QueryCommand) {
      return { Items: cfg.auditItems, LastEvaluatedKey: cfg.auditLastKey };
    }
    return {};
  }),
};
const shared = {
  runtime: makeTestControlDataRuntime(),
  ddb,
  eventsTableName: "Events",
  disruptionsTableName: "Disruptions",
  problemsDisruptions: {
    p1: [{ disruptionId: "d1", label: "Latency" }],
    p2: [{ disruptionId: "d2", label: "Kill" }],
  },
} as unknown as EventSharedResources;

const validCursor = Buffer.from(JSON.stringify({ PK: "EVENT#e1", SK: "AUDIT#9" }), "utf8").toString(
  "base64url",
);

beforeEach(() => {
  vi.clearAllMocks();
  cfg.eventItem = undefined;
  cfg.auditItems = [];
  cfg.auditLastKey = undefined;
});

describe("isEventOwnedByTenant", () => {
  it("should return true when the event belongs to the tenant", async () => {
    cfg.eventItem = { tenantId: "t1" };
    expect(await isEventOwnedByTenant(shared, "e1", "t1")).toBe(true);
  });
  it("should return false on a tenant mismatch", async () => {
    cfg.eventItem = { tenantId: "other" };
    expect(await isEventOwnedByTenant(shared, "e1", "t1")).toBe(false);
  });
  it("should return false when the event is absent", async () => {
    cfg.eventItem = undefined;
    expect(await isEventOwnedByTenant(shared, "e1", "t1")).toBe(false);
  });
});

describe("listDisruptionAudit", () => {
  it("should map a full audit row and emit nextCursor when paginated", async () => {
    cfg.auditItems = [
      {
        auditId: "a1",
        tenantId: "t1",
        eventId: "e1",
        problemId: "p1",
        disruptionId: "d1",
        firedBy: "sub",
        firedAt: "2026-06-01T00:00:00Z",
        scope: "team",
        targetTeamIds: ["team-1"],
        parameters: { latencyMs: 100 },
        requestId: "req-1",
        expiresAt: 123,
      },
    ];
    cfg.auditLastKey = { PK: "EVENT#e1", SK: "AUDIT#1" };
    const res = await listDisruptionAudit(shared, "e1");
    expect(res.items[0]).toMatchObject({
      auditId: "a1",
      targetTeamIds: ["team-1"],
      expiresAt: 123,
    });
    expect(res.nextCursor).toBeTypeOf("string");
  });

  it("should apply field defaults for a minimal row and omit nextCursor", async () => {
    cfg.auditItems = [{}];
    const res = await listDisruptionAudit(shared, "e1");
    expect(res.items[0]).toMatchObject({
      auditId: "",
      scope: "team",
      targetTeamIds: [],
      parameters: {},
      expiresAt: 0,
    });
    expect(res.nextCursor).toBeUndefined();
  });

  it("should default to [] when the query returns no Items", async () => {
    cfg.auditItems = undefined;
    expect((await listDisruptionAudit(shared, "e1")).items).toEqual([]);
  });

  it("should clamp the limit to [1, 200]", async () => {
    await listDisruptionAudit(shared, "e1", { limit: 9999 });
    expect(ddb.send.mock.calls[0][0].input.Limit).toBe(200);
    ddb.send.mockClear();
    await listDisruptionAudit(shared, "e1", { limit: 0 });
    expect(ddb.send.mock.calls[0][0].input.Limit).toBe(1);
  });

  it("should decode a valid cursor", async () => {
    await listDisruptionAudit(shared, "e1", { cursor: validCursor });
    expect(ddb.send.mock.calls[0][0].input.ExclusiveStartKey).toEqual({
      PK: "EVENT#e1",
      SK: "AUDIT#9",
    });
  });

  it.each([
    ["over-length", "x".repeat(513)],
    ["non-base64-json", "%%%not-json%%%"],
    ["array payload", Buffer.from("[1,2]", "utf8").toString("base64url")],
    ["disallowed key", Buffer.from(JSON.stringify({ evil: "x" }), "utf8").toString("base64url")],
    ["non-string value", Buffer.from(JSON.stringify({ PK: 123 }), "utf8").toString("base64url")],
    ["empty value", Buffer.from(JSON.stringify({ PK: "" }), "utf8").toString("base64url")],
    [
      "over-long value",
      Buffer.from(JSON.stringify({ PK: "y".repeat(257) }), "utf8").toString("base64url"),
    ],
  ])("should reject an invalid cursor (%s) and start from the beginning", async (_n, cursor) => {
    await listDisruptionAudit(shared, "e1", { cursor });
    expect(ddb.send.mock.calls[0][0].input.ExclusiveStartKey).toBeUndefined();
  });
});

describe("listDisruptionCatalog", () => {
  // #2436: repository seam 経由になり (shared, tenantId, eventId) 署名。 getEvent が tenant scope を
  // 内包するので fixture eventItem は tenantId を持つ (= seam の tenant 照合を通過させる)。
  it("should merge per-problem disruptions for the event's problems", async () => {
    cfg.eventItem = {
      tenantId: "t1",
      problems: [{ problemId: "p1" }, { problemId: "p2" }, { problemId: "pX" }],
    };
    const res = await listDisruptionCatalog(shared, "t1", "e1");
    // p1 + p2 have catalogs; pX has none → skipped.
    expect(res.entries.map((e) => e.problemId)).toEqual(["p1", "p2"]);
  });

  it("should filter out non-string problemIds", async () => {
    cfg.eventItem = { tenantId: "t1", problems: [{ problemId: 42 }, { problemId: "p1" }] };
    const res = await listDisruptionCatalog(shared, "t1", "e1");
    expect(res.entries.map((e) => e.problemId)).toEqual(["p1"]);
  });

  it("should return no entries when problems is missing or not an array", async () => {
    cfg.eventItem = { tenantId: "t1", problems: "not-an-array" };
    expect((await listDisruptionCatalog(shared, "t1", "e1")).entries).toEqual([]);
    cfg.eventItem = { tenantId: "t1" };
    expect((await listDisruptionCatalog(shared, "t1", "e1")).entries).toEqual([]);
  });

  it("should return no entries on a tenant mismatch (getEvent scopes by tenant)", async () => {
    cfg.eventItem = { tenantId: "other", problems: [{ problemId: "p1" }] };
    expect((await listDisruptionCatalog(shared, "t1", "e1")).entries).toEqual([]);
  });
});
