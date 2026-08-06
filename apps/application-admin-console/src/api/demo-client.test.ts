import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./client";
import { createDemoApiClient, demoRouteKey, resetDemoStore } from "./demo-client";
import type {
  BulkResult,
  CreateEventResponse,
  EventDetail,
  EventListResponse,
} from "./events-client";

const client = createDemoApiClient();

beforeEach(() => resetDemoStore());
afterEach(() => vi.useRealTimers());

describe("demoRouteKey", () => {
  it("should strip a leading slash and the query string", () => {
    expect(demoRouteKey("events")).toBe("events");
    expect(demoRouteKey("/events")).toBe("events");
    expect(demoRouteKey("events?limit=50&cursor=abc")).toBe("events");
    expect(demoRouteKey("/events/e-1?withScoreEvents=true")).toBe("events/e-1");
  });
});

describe("demo client — events list & detail", () => {
  it("should list the four seeded events", async () => {
    const res = await client.get<EventListResponse>("events");
    expect(res.items.map((e) => e.eventId)).toEqual([
      "demo-event-ready",
      "demo-event-deploying",
      "demo-event-ended",
      "demo-event-draft",
    ]);
  });

  it("should synthesize detail per status (COMPLETE / IN_PROGRESS / none)", async () => {
    const ready = await client.get<EventDetail>("events/demo-event-ready");
    expect(ready.teams).toHaveLength(3);
    expect(ready.problems).toHaveLength(2);
    expect(ready.deploymentsByProblem["demo-problem-1"]).toHaveLength(3);
    expect(ready.deploymentsByProblem["demo-problem-1"]?.[0]?.status).toBe("COMPLETE");

    const deploying = await client.get<EventDetail>("events/demo-event-deploying");
    expect(deploying.deploymentsByProblem["demo-problem-1"]?.[0]?.status).toBe("IN_PROGRESS");

    const draft = await client.get<EventDetail>("events/demo-event-draft");
    expect(draft.deploymentsByProblem).toEqual({});
  });

  it("should 404 on an unknown event id", async () => {
    await expect(client.get("events/does-not-exist")).rejects.toBeInstanceOf(ApiError);
    await expect(client.get("events/does-not-exist")).rejects.toThrow(/not found/i);
  });
});

describe("demo client — create + bulk deploy", () => {
  it("should create an event with login keys and surface it in the list + detail", async () => {
    const res = await client.post<CreateEventResponse>("events", {
      name: "My Demo Event",
      teams: [{ internalSlug: "alpha" }, { internalSlug: "bravo", awsAccountId: "111111111111" }],
      problems: [{ problemId: "hello-world", defaultRegion: "ap-northeast-1" }],
    });
    expect(res.status).toBe("DRAFT");
    expect(res.teams).toHaveLength(2);
    expect(res.teams[0]?.teamLoginKey).toBeTruthy();

    const list = await client.get<EventListResponse>("events");
    expect(list.items[0]?.eventId).toBe(res.eventId);
    expect(list.items[0]?.name).toBe("My Demo Event");

    const detail = await client.get<EventDetail>(`events/${res.eventId}`);
    expect(detail.teams).toHaveLength(2);
    expect(detail.teams[0]).not.toHaveProperty("teamLoginKey");
    expect(detail.deploymentsByProblem).toEqual({});

    const rotated = await client.post<{
      kind: "ok";
      teamId: string;
      teamLoginKey: string;
    }>(`events/${res.eventId}/teams/${res.teams[0]?.teamId}/rotate-login-key`, {});
    expect(rotated).toEqual({
      kind: "ok",
      teamId: res.teams[0]?.teamId,
      teamLoginKey: `demo-rotated-key-${res.eventId}-1`,
      rotatedAt: "2026-06-21T00:00:00.000Z",
    });
    expect((await client.get<EventDetail>(`events/${res.eventId}`)).teams[0]).not.toHaveProperty(
      "teamLoginKey",
    );
  });

  it("should progress a bulk deploy queued → deploying → ready over time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const created = await client.post<CreateEventResponse>("events", {
      name: "Deploy Me",
      teams: [{ internalSlug: "t1" }],
      problems: [{ problemId: "p1", defaultRegion: "ap-northeast-1" }],
    });
    const result = await client.post<BulkResult>(`events/${created.eventId}/deploy`, {});
    expect(result.enqueued).toBe(1); // 1 team × 1 problem
    expect(result.skipped).toBe(0);

    const statusAt = async (ms: number) => {
      vi.setSystemTime(ms);
      const d = await client.get<EventDetail>(`events/${created.eventId}`);
      return { event: d.status, deploy: d.deploymentsByProblem.p1?.[0]?.status };
    };

    expect(await statusAt(0)).toEqual({ event: "DEPLOYING", deploy: "PENDING" });
    expect(await statusAt(3000)).toEqual({ event: "DEPLOYING", deploy: "IN_PROGRESS" });
    expect(await statusAt(7000)).toEqual({ event: "READY", deploy: "COMPLETE" });

    // the list reflects the same derived status (EventList polling sees progress too).
    const list = await client.get<EventListResponse>("events");
    expect(list.items.find((e) => e.eventId === created.eventId)?.status).toBe("READY");
  });

  it("should 404 when rotating an unknown demo team", async () => {
    await expect(
      client.post("events/demo-event-ready/teams/missing-team/rotate-login-key", {}),
    ).rejects.toBeInstanceOf(ApiError);
    await expect(
      client.post("events/demo-event-ready/teams/missing-team/rotate-login-key", {}),
    ).rejects.toThrow(/team .* not found/i);
  });

  it("should 404 when deploying an unknown event", async () => {
    await expect(client.post("events/nope/deploy", {})).rejects.toBeInstanceOf(ApiError);
  });

  it("should isolate state between tests (resetDemoStore restores the seeds)", async () => {
    const list = await client.get<EventListResponse>("events");
    expect(list.items).toHaveLength(4);
  });
});

describe("demo client — unsupported routes throw NOT_IMPLEMENTED", () => {
  it("should refuse unmapped GET / POST paths and every other verb", async () => {
    await expect(client.get("deployments/x")).rejects.toThrow(/does not simulate/);
    await expect(client.get("events/x/extra")).rejects.toThrow(/does not simulate/);
    await expect(client.post("problems/x/deploy", {})).rejects.toThrow(/does not simulate/);
    await expect(client.post("events/e-1/end", {})).rejects.toThrow(/does not simulate/);
    await expect(client.put("events/x", {})).rejects.toBeInstanceOf(ApiError);
    await expect(client.patch("events/x", {})).rejects.toBeInstanceOf(ApiError);
    await expect(client.del("events/x")).rejects.toBeInstanceOf(ApiError);
    await expect(client.delJson("events/x")).rejects.toBeInstanceOf(ApiError);
  });
});
