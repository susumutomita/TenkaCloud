import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../src/api/client";
import {
  bulkDeployEvent,
  bulkTeardownEvent,
  createEvent,
  EVENT_ID_RE,
  getEvent,
  listEvents,
} from "../../src/api/events-client";

interface CapturedCall {
  path: string;
  method: "GET" | "POST" | "DELETE";
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
      teams: [{ internalSlug: "team-1" }],
      problems: [
        {
          problemId: "hello-world",
          defaultAwsAccountId: "999999999999",
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
