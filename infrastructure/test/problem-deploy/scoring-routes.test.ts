import { Hono } from "hono";
import { StatusCodes } from "http-status-codes";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Issue #1424: scoring lock / archive routes (routes/scoring.ts) の route 層を pin する。
 * POST/DELETE /lock-scoring と POST /archive の全 outcome→HTTP 分岐 (not_found / not_lockable /
 * not_archivable / ok / already idempotent) + error path。 service は mock、 auth は env、
 * eventId は valid ULID。
 */
const mocks = vi.hoisted(() => ({
  lockScoring: vi.fn(),
  unlockScoring: vi.fn(),
  archiveEvent: vi.fn(),
}));
vi.mock("../../lib/problem-deploy/handlers/event-handler/lock-scoring", () => ({
  lockScoring: mocks.lockScoring,
  unlockScoring: mocks.unlockScoring,
}));
vi.mock("../../lib/problem-deploy/handlers/event-handler/archive", () => ({
  archiveEvent: mocks.archiveEvent,
}));

const { registerScoringRoutes } = await import(
  "../../lib/problem-deploy/handlers/event-handler/routes/scoring"
);

const EVENT_ID = "01HZX0K3M3K9ZQHB3MRQHBA1B2";
// biome-ignore lint/suspicious/noExplicitAny: 最小 shared。
const shared = { ddb: { send: vi.fn() } } as any;
const buildApp = () => {
  const app = new Hono();
  registerScoringRoutes(app, shared);
  return app;
};
const req = (method: string, suffix: string) =>
  buildApp().request(`/events/${EVENT_ID}/${suffix}`, { method });

beforeAll(() => {
  process.env.DEFAULT_TENANT_ID = "tenant-test";
  process.env.DEFAULT_USER_ROLE = "TenantAdmin";
});
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.clearAllMocks());

describe("POST /events/:eventId/lock-scoring", () => {
  it("should 404 when not found", async () => {
    mocks.lockScoring.mockResolvedValueOnce({ kind: "not_found" });
    expect((await req("POST", "lock-scoring")).status).toBe(StatusCodes.NOT_FOUND);
  });

  it("should 409 with currentStatus when not lockable", async () => {
    mocks.lockScoring.mockResolvedValueOnce({ kind: "not_lockable", status: "DRAFT" });
    const res = await req("POST", "lock-scoring");
    expect(res.status).toBe(StatusCodes.CONFLICT);
    expect(await res.json()).toMatchObject({ error: "not_lockable", currentStatus: "DRAFT" });
  });

  it("should 200 with scoringLockedAt on a fresh lock", async () => {
    mocks.lockScoring.mockResolvedValueOnce({
      kind: "ok",
      scoringLocked: true,
      scoringLockedAt: "2026-06-01T00:00:00.000Z",
    });
    const res = await req("POST", "lock-scoring");
    expect(res.status).toBe(StatusCodes.OK);
    expect(await res.json()).toEqual({
      scoringLocked: true,
      scoringLockedAt: "2026-06-01T00:00:00.000Z",
      idempotent: false,
    });
  });

  it("should 200 idempotent when already locked", async () => {
    mocks.lockScoring.mockResolvedValueOnce({ kind: "already", scoringLocked: true });
    expect((await (await req("POST", "lock-scoring")).json()).idempotent).toBe(true);
  });

  it("should surface a lock error (5xx)", async () => {
    mocks.lockScoring.mockRejectedValueOnce(new Error("boom"));
    expect((await req("POST", "lock-scoring")).status).toBeGreaterThanOrEqual(500);
  });
});

describe("DELETE /events/:eventId/lock-scoring", () => {
  it("should 404 when not found", async () => {
    mocks.unlockScoring.mockResolvedValueOnce({ kind: "not_found" });
    expect((await req("DELETE", "lock-scoring")).status).toBe(StatusCodes.NOT_FOUND);
  });

  it("should 409 when not lockable", async () => {
    mocks.unlockScoring.mockResolvedValueOnce({ kind: "not_lockable", status: "ARCHIVED" });
    expect((await req("DELETE", "lock-scoring")).status).toBe(StatusCodes.CONFLICT);
  });

  it("should 200 on unlock and mark idempotent when already unlocked", async () => {
    mocks.unlockScoring.mockResolvedValueOnce({ kind: "ok", scoringLocked: false });
    expect((await (await req("DELETE", "lock-scoring")).json()).idempotent).toBe(false);
    mocks.unlockScoring.mockResolvedValueOnce({ kind: "already", scoringLocked: false });
    expect((await (await req("DELETE", "lock-scoring")).json()).idempotent).toBe(true);
  });

  it("should surface an unlock error (5xx)", async () => {
    mocks.unlockScoring.mockRejectedValueOnce(new Error("boom"));
    expect((await req("DELETE", "lock-scoring")).status).toBeGreaterThanOrEqual(500);
  });
});

describe("POST /events/:eventId/archive", () => {
  it("should 404 when not found", async () => {
    mocks.archiveEvent.mockResolvedValueOnce({ kind: "not_found" });
    expect((await req("POST", "archive")).status).toBe(StatusCodes.NOT_FOUND);
  });

  it("should 409 with currentStatus when not archivable", async () => {
    mocks.archiveEvent.mockResolvedValueOnce({ kind: "not_archivable", status: "RUNNING" });
    const res = await req("POST", "archive");
    expect(res.status).toBe(StatusCodes.CONFLICT);
    expect(await res.json()).toMatchObject({ error: "not_archivable", currentStatus: "RUNNING" });
  });

  it("should 200 with archivedAt on success", async () => {
    mocks.archiveEvent.mockResolvedValueOnce({
      kind: "ok",
      archivedAt: "2026-06-01T00:00:00.000Z",
    });
    const res = await req("POST", "archive");
    expect(res.status).toBe(StatusCodes.OK);
    expect(await res.json()).toEqual({ archivedAt: "2026-06-01T00:00:00.000Z" });
  });

  it("should surface an archive error (5xx)", async () => {
    mocks.archiveEvent.mockRejectedValueOnce(new Error("boom"));
    expect((await req("POST", "archive")).status).toBeGreaterThanOrEqual(500);
  });
});
