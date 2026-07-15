import { Hono } from "hono";
import { StatusCodes } from "http-status-codes";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Issue #1424: event CRUD + bulk-teardown routes (routes/events.ts)。
 * POST /events, GET /events, GET /events/:id, DELETE /events/:id の
 * validation / duplicate / pagination / one-time login-key / not_found / error 分岐。
 *
 * create module は importOriginal で error class (Duplicate*) を実体のまま残しつつ
 * createEvent だけ mock 化する (= route の `err instanceof Duplicate*` を本物の class で判定)。
 */
const mocks = vi.hoisted(() => ({
  createEvent: vi.fn(),
  listEvents: vi.fn(),
  getEventDetail: vi.fn(),
  bulkTeardownEvent: vi.fn(),
  rotateTeamLoginKey: vi.fn(),
}));
vi.mock("../../lib/problem-deploy/handlers/event-handler/create", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../lib/problem-deploy/handlers/event-handler/create")>();
  return { ...actual, createEvent: mocks.createEvent };
});
vi.mock("../../lib/problem-deploy/handlers/event-handler/list", () => ({
  listEvents: mocks.listEvents,
  getEventDetail: mocks.getEventDetail,
}));
vi.mock("../../lib/problem-deploy/handlers/event-handler/bulk-delete", () => ({
  bulkTeardownEvent: mocks.bulkTeardownEvent,
}));
vi.mock("../../lib/problem-deploy/handlers/event-handler/rotate-team-login-key", () => ({
  rotateTeamLoginKey: mocks.rotateTeamLoginKey,
}));

const { registerEventRoutes } = await import(
  "../../lib/problem-deploy/handlers/event-handler/routes/events"
);
const { DuplicateInternalSlugError, DuplicateProblemIdError } = await import(
  "../../lib/problem-deploy/handlers/event-handler/create"
);

const EVENT_ID = "01HZX0K3M3K9ZQHB3MRQHBA1B2";
// biome-ignore lint/suspicious/noExplicitAny: 最小 shared。
const shared = { ddb: { send: vi.fn() } } as any;
const buildApp = () => {
  const app = new Hono();
  registerEventRoutes(app, shared);
  return app;
};
const postEvent = (body: unknown) =>
  buildApp().request("/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const getEvents = (query = "") => buildApp().request(`/events${query}`);
const getDetail = (query = "") => buildApp().request(`/events/${EVENT_ID}${query}`);
const deleteEvent = () => buildApp().request(`/events/${EVENT_ID}`, { method: "DELETE" });
const TEAM_ID = "01HZX0K3M3K9ZQHB3MRQHBA1B3";
const rotateLoginKey = (teamId = TEAM_ID) =>
  buildApp().request(`/events/${EVENT_ID}/teams/${teamId}/rotate-login-key`, { method: "POST" });
const validCreateBody = {
  name: "Spring Cup",
  teams: [{ internalSlug: "team-a", awsAccountId: "123456789012" }],
  problems: [{ problemId: "p-1", defaultRegion: "ap-northeast-1" }],
};

beforeAll(() => {
  process.env.DEFAULT_TENANT_ID = "tenant-test";
  process.env.DEFAULT_USER_ROLE = "TenantAdmin";
});
beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  vi.clearAllMocks();
  process.env.DEFAULT_USER_ROLE = "TenantAdmin"; // restore after per-test role overrides
});

describe("POST /events", () => {
  it("should 400 on an invalid body", async () => {
    const res = await postEvent({ name: "" }); // missing teams/problems
    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    expect(mocks.createEvent).not.toHaveBeenCalled();
  });

  it("should 201 with the created event", async () => {
    mocks.createEvent.mockResolvedValueOnce({ eventId: "evt-1" });
    const res = await postEvent(validCreateBody);
    expect(res.status).toBe(StatusCodes.CREATED);
    expect(await res.json()).toEqual({ eventId: "evt-1" });
  });

  it("should 400 with duplicate_internal_slug on DuplicateInternalSlugError", async () => {
    mocks.createEvent.mockRejectedValueOnce(new DuplicateInternalSlugError("team-a"));
    const res = await postEvent(validCreateBody);
    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    expect(await res.json()).toEqual({ error: "duplicate_internal_slug", slug: "team-a" });
  });

  it("should 400 with duplicate_problem_id on DuplicateProblemIdError", async () => {
    mocks.createEvent.mockRejectedValueOnce(new DuplicateProblemIdError("p-1"));
    const res = await postEvent(validCreateBody);
    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    expect(await res.json()).toEqual({ error: "duplicate_problem_id", problemId: "p-1" });
  });

  it("should surface an unexpected createEvent error (5xx)", async () => {
    mocks.createEvent.mockRejectedValueOnce(new Error("boom"));
    expect((await postEvent(validCreateBody)).status).toBeGreaterThanOrEqual(500);
  });
});

describe("GET /events", () => {
  it("should 400 on an invalid limit", async () => {
    const res = await getEvents("?limit=0");
    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    expect((await res.json()).error).toBe("invalid_limit");
  });

  it("should 200 and pass limit + cursor to listEvents", async () => {
    mocks.listEvents.mockResolvedValueOnce({ events: [], cursor: null });
    const res = await getEvents("?limit=10&cursor=tok");
    expect(res.status).toBe(StatusCodes.OK);
    expect(mocks.listEvents).toHaveBeenCalledWith(shared, {
      tenantId: "tenant-test",
      limit: 10,
      cursor: "tok",
    });
  });

  it("should surface a listEvents error (5xx)", async () => {
    mocks.listEvents.mockRejectedValueOnce(new Error("boom"));
    expect((await getEvents()).status).toBeGreaterThanOrEqual(500);
  });
});

describe("GET /events/:eventId", () => {
  it("should 404 when the detail is not found", async () => {
    mocks.getEventDetail.mockResolvedValueOnce(null);
    expect((await getDetail()).status).toBe(StatusCodes.NOT_FOUND);
  });

  it("should request score events without enabling a credential re-read path", async () => {
    mocks.getEventDetail.mockResolvedValueOnce({ eventId: EVENT_ID });
    const res = await getDetail("?withScoreEvents=true");
    expect(res.status).toBe(StatusCodes.OK);
    expect(mocks.getEventDetail).toHaveBeenCalledWith(shared, "tenant-test", EVENT_ID, {
      withScoreEvents: true,
    });
  });

  it("should use the same one-time-key contract for a read-only viewer role", async () => {
    process.env.DEFAULT_USER_ROLE = "TenantViewer";
    mocks.getEventDetail.mockResolvedValueOnce({ eventId: EVENT_ID });
    await getDetail();
    expect(mocks.getEventDetail.mock.calls[0][3]).toEqual({
      withScoreEvents: false,
    });
  });

  it("should surface a getEventDetail error (5xx)", async () => {
    mocks.getEventDetail.mockRejectedValueOnce(new Error("boom"));
    expect((await getDetail()).status).toBeGreaterThanOrEqual(500);
  });
});

describe("DELETE /events/:eventId", () => {
  it("should 404 when the event is not found", async () => {
    mocks.bulkTeardownEvent.mockResolvedValueOnce({ kind: "not_found" });
    expect((await deleteEvent()).status).toBe(StatusCodes.NOT_FOUND);
  });

  it("should 202 with the teardown result", async () => {
    mocks.bulkTeardownEvent.mockResolvedValueOnce({ kind: "ok", result: { teardown: 4 } });
    const res = await deleteEvent();
    expect(res.status).toBe(StatusCodes.ACCEPTED);
    expect(await res.json()).toEqual({ teardown: 4 });
  });

  it("should surface a bulkTeardownEvent error (5xx)", async () => {
    mocks.bulkTeardownEvent.mockRejectedValueOnce(new Error("boom"));
    expect((await deleteEvent()).status).toBeGreaterThanOrEqual(500);
  });
});

describe("POST /events/:eventId/teams/:teamId/rotate-login-key", () => {
  it("should reject a malformed team id before rotation", async () => {
    expect((await rotateLoginKey("bad-team-id")).status).toBe(StatusCodes.BAD_REQUEST);
    expect(mocks.rotateTeamLoginKey).not.toHaveBeenCalled();
  });

  it("should return 404 when the team is absent", async () => {
    mocks.rotateTeamLoginKey.mockResolvedValueOnce({ kind: "not_found" });
    expect((await rotateLoginKey()).status).toBe(StatusCodes.NOT_FOUND);
  });

  it("should return the one-time replacement key", async () => {
    mocks.rotateTeamLoginKey.mockResolvedValueOnce({
      kind: "ok",
      teamId: TEAM_ID,
      teamLoginKey: "NEW-KEY",
      rotatedAt: "2026-07-15T00:00:00.000Z",
    });
    const response = await rotateLoginKey();
    expect(response.status).toBe(StatusCodes.OK);
    expect(await response.json()).toEqual({
      kind: "ok",
      teamId: TEAM_ID,
      teamLoginKey: "NEW-KEY",
      rotatedAt: "2026-07-15T00:00:00.000Z",
    });
  });

  it("should return 409 when a concurrent deployment changed the rotation set", async () => {
    mocks.rotateTeamLoginKey.mockResolvedValueOnce({ kind: "conflict" });
    const response = await rotateLoginKey();
    expect(response.status).toBe(StatusCodes.CONFLICT);
    expect(await response.json()).toEqual({ error: "rotation_conflict" });
  });

  it("should surface an unexpected rotation error as 500", async () => {
    mocks.rotateTeamLoginKey.mockRejectedValueOnce(new Error("database unavailable"));
    expect((await rotateLoginKey()).status).toBe(StatusCodes.INTERNAL_SERVER_ERROR);
  });
});
