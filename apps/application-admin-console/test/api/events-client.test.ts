import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../src/api/client";
import {
  archiveEvent,
  bulkDeployEvent,
  bulkTeardownEvent,
  createEvent,
  createNotification,
  EVENT_ID_RE,
  endEvent,
  getEvent,
  listEvents,
  lockEventScoring,
  setEventSchedule,
  unlockEventScoring,
} from "../../src/api/events-client";

interface CapturedCall {
  path: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
}

function fakeClient(response: unknown): { client: ApiClient; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const client: ApiClient = {
    get: vi.fn().mockImplementation((path: string) => {
      calls.push({ path, method: "GET" });
      return Promise.resolve(response);
    }),
    post: vi.fn().mockImplementation((path: string, body: unknown) => {
      calls.push({ path, method: "POST", body });
      return Promise.resolve(response);
    }),
    patch: vi.fn().mockImplementation((path: string, body: unknown) => {
      calls.push({ path, method: "PATCH", body });
      return Promise.resolve(response);
    }),
    del: vi.fn().mockImplementation((path: string) => {
      calls.push({ path, method: "DELETE" });
      return Promise.resolve();
    }),
    delJson: vi.fn().mockImplementation((path: string) => {
      calls.push({ path, method: "DELETE" });
      return Promise.resolve(response);
    }),
  };
  return { client, calls };
}

describe("EVENT_ID_RE", () => {
  it("should match ULID format only", () => {
    expect(EVENT_ID_RE.test("01KQZRZSTT6EQC9JVK4FQKRKKM")).toBe(true);
    expect(EVENT_ID_RE.test("not-a-ulid")).toBe(false);
    expect(EVENT_ID_RE.test("01kqzrzstt6eqc9jvk4fqkrkkm")).toBe(false); // lowercase
    expect(EVENT_ID_RE.test("01IQZRZSTT6EQC9JVK4FQKRKKM")).toBe(false); // I は Crockford Base32 から除外
  });
});

describe("listEvents", () => {
  it("should pack limit / cursor into the query string", async () => {
    const { client, calls } = fakeClient({ items: [] });
    await listEvents(client, { limit: 50, cursor: "abc" });
    expect(calls[0]?.path).toBe("events?limit=50&cursor=abc");
  });

  it("should call plain `events` when no options are provided", async () => {
    const { client, calls } = fakeClient({ items: [] });
    await listEvents(client);
    expect(calls[0]?.path).toBe("events");
  });
});

describe("getEvent", () => {
  it("should URL-encode eventId and GET it", async () => {
    const { client, calls } = fakeClient({ eventId: "EV1" });
    await getEvent(client, "EV1");
    expect(calls[0]?.path).toBe("events/EV1");
    expect(calls[0]?.method).toBe("GET");
  });

  it("should append ?withScoreEvents=true when requested", async () => {
    const { client, calls } = fakeClient({ eventId: "EV1" });
    await getEvent(client, "EV1", { withScoreEvents: true });
    expect(calls[0]?.path).toBe("events/EV1?withScoreEvents=true");
  });
});

describe("createEvent", () => {
  it("should POST body as-is to /events", async () => {
    const { client, calls } = fakeClient({
      eventId: "EV1",
      status: "DRAFT",
      createdAt: "now",
      expiresAt: 0,
      teams: [],
      problems: [],
    });
    await createEvent(client, {
      name: "Spring",
      // #528: 各 team は自社 AWS account を持つ。problem からは defaultAwsAccountId が消えた
      teams: [{ internalSlug: "team-1", awsAccountId: "111111111111" }],
      problems: [
        {
          problemId: "hello-world",
          defaultRegion: "ap-northeast-1",
        },
      ],
    });
    expect(calls[0]?.path).toBe("events");
    expect(calls[0]?.method).toBe("POST");
    expect((calls[0]?.body as { name?: string })?.name).toBe("Spring");
  });
});

describe("bulkDeployEvent", () => {
  it("should POST /events/{id}/deploy with an empty body and return BulkResult", async () => {
    const { client, calls } = fakeClient({ eventId: "EV1", enqueued: 6, skipped: 0 });
    const out = await bulkDeployEvent(client, "EV1");
    expect(calls[0]?.path).toBe("events/EV1/deploy");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toEqual({});
    expect(out.enqueued).toBe(6);
  });

  // #555: opt-in body の partial deploy / retry-failed 経路
  it("should POST with retryFailedOnly: true passed through in body", async () => {
    const { client, calls } = fakeClient({ eventId: "EV1", enqueued: 2, skipped: 0 });
    await bulkDeployEvent(client, "EV1", { retryFailedOnly: true });
    expect(calls[0]?.path).toBe("events/EV1/deploy");
    expect(calls[0]?.body).toEqual({ retryFailedOnly: true });
  });

  it("should POST with teamIds / problemIds passed through in body (partial deploy)", async () => {
    const { client, calls } = fakeClient({ eventId: "EV1", enqueued: 2, skipped: 0 });
    await bulkDeployEvent(client, "EV1", { teamIds: ["t1"], problemIds: ["hello-world"] });
    expect(calls[0]?.body).toEqual({ teamIds: ["t1"], problemIds: ["hello-world"] });
  });

  it("should POST with forceRedeploy: true passed through in body", async () => {
    const { client, calls } = fakeClient({ eventId: "EV1", enqueued: 2, skipped: 0 });
    await bulkDeployEvent(client, "EV1", { forceRedeploy: true });
    expect(calls[0]?.body).toEqual({ forceRedeploy: true });
  });
});

describe("bulkTeardownEvent", () => {
  it("should DELETE /events/{id} and return BulkResult (via delJson)", async () => {
    const { client, calls } = fakeClient({ eventId: "EV1", enqueued: 6, skipped: 0 });
    const out = await bulkTeardownEvent(client, "EV1");
    expect(calls[0]?.path).toBe("events/EV1");
    expect(calls[0]?.method).toBe("DELETE");
    expect(out.enqueued).toBe(6);
  });
});

describe("endEvent", () => {
  it("should POST /events/{id}/end with an empty body and return EndEventResult", async () => {
    const { client, calls } = fakeClient({
      endsAt: "2026-05-08T10:00:00.000Z",
      updatedDeployments: 12,
    });
    const out = await endEvent(client, "EV1");
    expect(calls[0]?.path).toBe("events/EV1/end");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toEqual({});
    expect(out.endsAt).toBe("2026-05-08T10:00:00.000Z");
    expect(out.updatedDeployments).toBe(12);
  });
});

describe("archiveEvent", () => {
  it("should POST /events/{id}/archive with an empty body and return ArchiveEventResult", async () => {
    const { client, calls } = fakeClient({ archivedAt: "2026-05-09T10:00:00.000Z" });
    const out = await archiveEvent(client, "EV1");
    expect(calls[0]?.path).toBe("events/EV1/archive");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toEqual({});
    expect(out.archivedAt).toBe("2026-05-09T10:00:00.000Z");
  });
});

describe("setEventSchedule", () => {
  it("should PATCH /events/{id}/schedule with the body and return the result", async () => {
    const { client, calls } = fakeClient({ startsAt: "2026-06-01T00:00:00Z" });
    const out = await setEventSchedule(client, "EV1", { startsAt: "2026-06-01T00:00:00Z" });
    expect(calls[0]?.path).toBe("events/EV1/schedule");
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.body).toEqual({ startsAt: "2026-06-01T00:00:00Z" });
    expect((out as { startsAt: string }).startsAt).toBe("2026-06-01T00:00:00Z");
  });
});

describe("lockEventScoring", () => {
  it("should POST /events/{id}/lock-scoring with an empty body", async () => {
    const { client, calls } = fakeClient({ scoringLocked: true });
    const out = await lockEventScoring(client, "EV1");
    expect(calls[0]?.path).toBe("events/EV1/lock-scoring");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toEqual({});
    expect(out.scoringLocked).toBe(true);
  });
});

describe("unlockEventScoring", () => {
  it("should DELETE /events/{id}/lock-scoring (via delJson)", async () => {
    const { client, calls } = fakeClient({ scoringLocked: false });
    const out = await unlockEventScoring(client, "EV1");
    expect(calls[0]?.path).toBe("events/EV1/lock-scoring");
    expect(calls[0]?.method).toBe("DELETE");
    expect(out.scoringLocked).toBe(false);
  });
});

describe("createNotification", () => {
  it("should POST /events/{id}/notifications with the notification body", async () => {
    const { client, calls } = fakeClient({
      notificationId: "n1",
      occurredAt: "2026-06-01T00:00:00Z",
    });
    const out = await createNotification(client, "EV1", {
      title: "T",
      body: "B",
      severity: "warning",
    });
    expect(calls[0]?.path).toBe("events/EV1/notifications");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toEqual({ title: "T", body: "B", severity: "warning" });
    expect(out.notificationId).toBe("n1");
  });
});
