import { Hono } from "hono";
import { StatusCodes } from "http-status-codes";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventSharedResources } from "../../lib/problem-deploy/handlers/event-handler/shared";

/**
 * [Issue #3126] Coordination run-reset route
 * (`POST /events/:eventId/problems/:problemId/coordination/reset`).
 *
 * The reset is destructive and deliberately separate from deploy, so the route
 * has to get its guards right: operator-only, `not_found` for a problem the
 * event never deployed, and a 5xx that does not swallow a backend failure into
 * a cheerful success.
 */
const mocks = vi.hoisted(() => ({ resetCoordinationRun: vi.fn() }));
vi.mock("../../lib/problem-deploy/handlers/event-handler/coordination-reset", () => ({
  resetCoordinationRun: mocks.resetCoordinationRun,
}));

const { registerCoordinationRoutes } = await import(
  "../../lib/problem-deploy/handlers/event-handler/routes/coordination"
);

const EVENT_ID = "01HZX0K3M3K9ZQHB3MRQHBA1B2";
const PROBLEM_ID = "ac26-crypto-battle";
// The route only forwards `shared` to the (mocked) reset, so the minimal shape
// is enough — casting through `unknown` keeps that explicit without `any`.
const shared = { ddb: { send: vi.fn() } } as unknown as EventSharedResources;

const reset = (problemId: string = PROBLEM_ID) => {
  const app = new Hono();
  registerCoordinationRoutes(app, shared);
  return app.request(`/events/${EVENT_ID}/problems/${problemId}/coordination/reset`, {
    method: "POST",
  });
};

beforeAll(() => {
  process.env.DEFAULT_TENANT_ID = "tenant-test";
  process.env.DEFAULT_USER_ROLE = "TenantAdmin";
});
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.clearAllMocks());

describe("POST /events/:eventId/problems/:problemId/coordination/reset", () => {
  it("should 200 with the cleared namespace", async () => {
    mocks.resetCoordinationRun.mockResolvedValueOnce({
      kind: "ok",
      result: {
        eventId: EVENT_ID,
        problemId: PROBLEM_ID,
        runId: "rNEW",
        // [Issue #3153] The run that just ended, still readable under its own
        // scope until the retention window pushes it out.
        previousRunId: "default",
      },
    });

    const res = await reset();

    expect(res.status).toBe(StatusCodes.OK);
    expect(await res.json()).toEqual({
      eventId: EVENT_ID,
      problemId: PROBLEM_ID,
      runId: "rNEW",
      previousRunId: "default",
    });
    expect(mocks.resetCoordinationRun).toHaveBeenCalledWith(
      shared,
      "tenant-test",
      EVENT_ID,
      PROBLEM_ID,
    );
  });

  it("should 404 when the event never deployed that problem", async () => {
    // The guard that keeps a mistyped problemId from reading as a successful
    // reset of a match the operator never touched.
    mocks.resetCoordinationRun.mockResolvedValueOnce({ kind: "not_found" });

    const res = await reset("battel-a");

    expect(res.status).toBe(StatusCodes.NOT_FOUND);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("should surface a backend failure instead of reporting a reset that never happened", async () => {
    mocks.resetCoordinationRun.mockRejectedValueOnce(new Error("dynamodb unavailable"));

    const res = await reset();

    expect(res.status).toBe(StatusCodes.INTERNAL_SERVER_ERROR);
  });

  it("should 409 when another operator started a run first (#3153)", async () => {
    // Two operators resetting the same match at once must not end up with two
    // runs started and one silently discarded. The caller is told, and can look
    // at which run is current before deciding whether they still want another.
    mocks.resetCoordinationRun.mockResolvedValueOnce({ kind: "conflict" });

    const res = await reset();

    expect(res.status).toBe(StatusCodes.CONFLICT);
    expect(await res.json()).toEqual({ error: "run_rotation_conflict" });
  });
});
