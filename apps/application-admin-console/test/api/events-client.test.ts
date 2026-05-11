import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../src/api/client";
import {
  archiveEvent,
  bulkDeployEvent,
  bulkTeardownEvent,
  createEvent,
  EVENT_ID_RE,
  endEvent,
  getEvent,
  listEvents,
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
  it("ULID 形式のみマッチするべき", () => {
    expect(EVENT_ID_RE.test("01KQZRZSTT6EQC9JVK4FQKRKKM")).toBe(true);
    expect(EVENT_ID_RE.test("not-a-ulid")).toBe(false);
    expect(EVENT_ID_RE.test("01kqzrzstt6eqc9jvk4fqkrkkm")).toBe(false); // lowercase
    expect(EVENT_ID_RE.test("01IQZRZSTT6EQC9JVK4FQKRKKM")).toBe(false); // I は Crockford Base32 から除外
  });
});

describe("listEvents", () => {
  it("limit / cursor を query string に詰めるべき", async () => {
    const { client, calls } = fakeClient({ items: [] });
    await listEvents(client, { limit: 50, cursor: "abc" });
    expect(calls[0]?.path).toBe("events?limit=50&cursor=abc");
  });

  it("オプション無しは plain `events` を呼ぶべき", async () => {
    const { client, calls } = fakeClient({ items: [] });
    await listEvents(client);
    expect(calls[0]?.path).toBe("events");
  });
});

describe("getEvent", () => {
  it("eventId を URL encode して GET するべき", async () => {
    const { client, calls } = fakeClient({ eventId: "EV1" });
    await getEvent(client, "EV1");
    expect(calls[0]?.path).toBe("events/EV1");
    expect(calls[0]?.method).toBe("GET");
  });
});

describe("createEvent", () => {
  it("POST /events に body をそのまま送るべき", async () => {
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
  it("POST /events/{id}/deploy を空 body で呼び結果 BulkResult を返すべき", async () => {
    const { client, calls } = fakeClient({ eventId: "EV1", enqueued: 6, skipped: 0 });
    const out = await bulkDeployEvent(client, "EV1");
    expect(calls[0]?.path).toBe("events/EV1/deploy");
    expect(calls[0]?.method).toBe("POST");
    expect(out.enqueued).toBe(6);
  });
});

describe("bulkTeardownEvent", () => {
  it("DELETE /events/{id} を呼んで BulkResult を返すべき (delJson 経由)", async () => {
    const { client, calls } = fakeClient({ eventId: "EV1", enqueued: 6, skipped: 0 });
    const out = await bulkTeardownEvent(client, "EV1");
    expect(calls[0]?.path).toBe("events/EV1");
    expect(calls[0]?.method).toBe("DELETE");
    expect(out.enqueued).toBe(6);
  });
});

describe("endEvent", () => {
  it("POST /events/{id}/end を空 body で呼び EndEventResult を返すべき", async () => {
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
  it("POST /events/{id}/archive を空 body で呼び ArchiveEventResult を返すべき", async () => {
    const { client, calls } = fakeClient({ archivedAt: "2026-05-09T10:00:00.000Z" });
    const out = await archiveEvent(client, "EV1");
    expect(calls[0]?.path).toBe("events/EV1/archive");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toEqual({});
    expect(out.archivedAt).toBe("2026-05-09T10:00:00.000Z");
  });
});
