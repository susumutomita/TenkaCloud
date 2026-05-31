import { Hono } from "hono";
import { StatusCodes } from "http-status-codes";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Issue #1424: event lifecycle routes (routes/lifecycle.ts) の route 層を pin する。
 * PATCH /events/:id/schedule と POST /events/:id/end の全 outcome→HTTP 分岐 + error path。
 * service (schedule / end-event) は mock、 auth は dev override env、 eventId は valid ULID。
 */
const mocks = vi.hoisted(() => ({ setEventSchedule: vi.fn(), endEvent: vi.fn() }));
vi.mock("../../lib/problem-deploy/handlers/event-handler/schedule", () => ({
  setEventSchedule: mocks.setEventSchedule,
}));
vi.mock("../../lib/problem-deploy/handlers/event-handler/end-event", () => ({
  endEvent: mocks.endEvent,
}));

const { registerLifecycleRoutes } = await import(
  "../../lib/problem-deploy/handlers/event-handler/routes/lifecycle"
);

const EVENT_ID = "01HZX0K3M3K9ZQHB3MRQHBA1B2";
// biome-ignore lint/suspicious/noExplicitAny: 最小 shared (route は service に渡すだけ)。
const shared = { ddb: { send: vi.fn() } } as any;
const buildApp = () => {
  const app = new Hono();
  registerLifecycleRoutes(app, shared);
  return app;
};
const patchSchedule = (body: unknown) =>
  buildApp().request(`/events/${EVENT_ID}/schedule`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const postEnd = () => buildApp().request(`/events/${EVENT_ID}/end`, { method: "POST" });

beforeAll(() => {
  process.env.DEFAULT_TENANT_ID = "tenant-test";
  process.env.DEFAULT_USER_ROLE = "TenantAdmin";
});
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.clearAllMocks());

describe("PATCH /events/:eventId/schedule", () => {
  it("should 400 on an invalid body", async () => {
    const res = await patchSchedule({ startsAt: 12345 }); // not a string → schema reject
    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
  });

  it("should resolve startNow to a server timestamp and return ok", async () => {
    mocks.setEventSchedule.mockResolvedValueOnce({
      kind: "ok",
      startsAt: "2026-06-01T00:00:00.000Z",
      endsAt: undefined,
      updatedDeployments: 3,
    });
    const res = await patchSchedule({ startNow: true });
    expect(res.status).toBe(StatusCodes.OK);
    expect((await res.json()).updatedDeployments).toBe(3);
    // startNow → resolvedStartsAt is an ISO string (not undefined).
    expect(typeof mocks.setEventSchedule.mock.calls[0][3].startsAt).toBe("string");
  });

  it("should pass an explicit startsAt through when startNow is false", async () => {
    mocks.setEventSchedule.mockResolvedValueOnce({ kind: "ok", updatedDeployments: 0 });
    await patchSchedule({ startsAt: "2099-01-01T00:00:00.000Z" });
    expect(mocks.setEventSchedule.mock.calls[0][3].startsAt).toBe("2099-01-01T00:00:00.000Z");
  });

  it.each([
    ["not_found", { kind: "not_found" }, StatusCodes.NOT_FOUND, "not_found"],
    [
      "past_starts_at",
      { kind: "past_starts_at", startsAt: "2000-01-01T00:00:00Z", nowMs: 0 },
      StatusCodes.BAD_REQUEST,
      "past_starts_at",
    ],
    [
      "past_ends_at",
      { kind: "past_ends_at", endsAt: "2000-01-01T00:00:00Z", nowMs: 0 },
      StatusCodes.BAD_REQUEST,
      "past_ends_at",
    ],
    [
      "ends_before_starts",
      {
        kind: "ends_before_starts",
        startsAt: "2099-01-02T00:00:00Z",
        endsAt: "2099-01-01T00:00:00Z",
      },
      StatusCodes.BAD_REQUEST,
      "ends_before_starts",
    ],
    ["no_op", { kind: "no_op" }, StatusCodes.BAD_REQUEST, "no_op"],
  ])("should map the %s outcome to its HTTP response", async (_name, outcome, status, err) => {
    mocks.setEventSchedule.mockResolvedValueOnce(outcome);
    const res = await patchSchedule({ startNow: true });
    expect(res.status).toBe(status);
    expect((await res.json()).error).toBe(err);
  });

  it("should surface a schedule error via handleRouteError (5xx)", async () => {
    mocks.setEventSchedule.mockRejectedValueOnce(new Error("ddb boom"));
    const res = await patchSchedule({ startNow: true });
    expect(res.status).toBeGreaterThanOrEqual(500);
  });
});

describe("POST /events/:eventId/end", () => {
  it("should 404 when the event is not found", async () => {
    mocks.endEvent.mockResolvedValueOnce({ kind: "not_found" });
    expect((await postEnd()).status).toBe(StatusCodes.NOT_FOUND);
  });

  it("should 409 with the current status when not endable", async () => {
    mocks.endEvent.mockResolvedValueOnce({ kind: "not_endable", status: "DRAFT" });
    const res = await postEnd();
    expect(res.status).toBe(StatusCodes.CONFLICT);
    expect(await res.json()).toMatchObject({ error: "not_endable", currentStatus: "DRAFT" });
  });

  it("should 200 with endsAt + updatedDeployments on success", async () => {
    mocks.endEvent.mockResolvedValueOnce({
      kind: "ok",
      endsAt: "2026-06-01T00:00:00.000Z",
      updatedDeployments: 2,
    });
    const res = await postEnd();
    expect(res.status).toBe(StatusCodes.OK);
    expect(await res.json()).toEqual({ endsAt: "2026-06-01T00:00:00.000Z", updatedDeployments: 2 });
  });

  it("should surface an end error via handleRouteError (5xx)", async () => {
    mocks.endEvent.mockRejectedValueOnce(new Error("end boom"));
    expect((await postEnd()).status).toBeGreaterThanOrEqual(500);
  });
});
