import { Hono } from "hono";
import { StatusCodes } from "http-status-codes";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  handleRouteError,
  parseJsonBody,
  parseLimit,
  parseOptionalJsonBody,
  requireEventOwnership,
  withEventId,
  withJsonBody,
} from "../../lib/problem-deploy/handlers/event-handler/route-helpers";
import type { EventSharedResources } from "../../lib/problem-deploy/handlers/event-handler/shared";

/**
 * Issue #2196 (RC-21 第1弾): event-handler `route-helpers.ts` の共有プラミングは
 * 多数のルートが依存するのに専用テストが無かった。 `invalid_body` / `validation_failed` +
 * `issues` / `invalid_event_id` の JSON 形状はフロントとの実質契約なので、 統合リファクタ
 * (RC-21 第2弾) の前に明示的な shape assertion で固定する。 本体コードは変更しない。
 */

const VALID_ULID = "01HZX0K3M3K9ZQHB3MRQHBA1B2";

function buildShared(): { shared: EventSharedResources; ddbSend: ReturnType<typeof vi.fn> } {
  const ddbSend = vi.fn();
  const shared: EventSharedResources = {
    eventsTableName: "TestEvents",
    teamsTableName: "TestTeams",
    deploymentsTableName: "TestDeployments",
    eventBusName: "TestBus",
    ddb: { send: ddbSend } as unknown as EventSharedResources["ddb"],
    events: {} as EventSharedResources["events"],
    problemsCatalog: {},
  };
  return { shared, ddbSend };
}

describe("parseLimit", () => {
  it("should return limit: undefined when the value is unspecified", () => {
    expect(parseLimit(undefined)).toEqual({ ok: true, limit: undefined });
  });

  it("should parse a valid in-range integer string", () => {
    expect(parseLimit("50")).toEqual({ ok: true, limit: 50 });
  });

  it("should return null for a non-numeric value", () => {
    expect(parseLimit("abc")).toBeNull();
  });

  it("should return null when the value exceeds LIST_LIMIT_MAX (200)", () => {
    expect(parseLimit("201")).toBeNull();
  });

  it("should return null for zero or negative values", () => {
    expect(parseLimit("0")).toBeNull();
    expect(parseLimit("-1")).toBeNull();
  });
});

describe("withEventId", () => {
  it("should extract a valid ULID eventId and call the handler", async () => {
    const app = new Hono();
    app.get(
      "/events/:eventId",
      withEventId(({ c, eventId }) => c.json({ eventId })),
    );

    const res = await app.request(`/events/${VALID_ULID}`);

    expect(res.status).toBe(StatusCodes.OK);
    expect(await res.json()).toEqual({ eventId: VALID_ULID });
  });

  it("should 400 invalid_event_id when the path segment is not a ULID", async () => {
    const app = new Hono();
    app.get(
      "/events/:eventId",
      withEventId(({ c, eventId }) => c.json({ eventId })),
    );

    const res = await app.request("/events/not-a-ulid");

    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    expect(await res.json()).toEqual({ error: "invalid_event_id" });
  });
});

const TestSchema = z.object({ name: z.string().min(1) });

describe("withJsonBody", () => {
  it("should call the handler with typed body data on success", async () => {
    const app = new Hono();
    app.post(
      "/x",
      withJsonBody(TestSchema, ({ c, body }) => c.json({ received: body })),
    );

    const res = await app.request("/x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "alice" }),
    });

    expect(res.status).toBe(StatusCodes.OK);
    expect(await res.json()).toEqual({ received: { name: "alice" } });
  });

  it("should 400 invalid_body on malformed JSON", async () => {
    const app = new Hono();
    app.post(
      "/x",
      withJsonBody(TestSchema, ({ c, body }) => c.json({ received: body })),
    );

    const res = await app.request("/x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });

    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    expect(await res.json()).toEqual({ error: "invalid_body" });
  });

  it("should 400 validation_failed with issues on a schema mismatch", async () => {
    const app = new Hono();
    app.post(
      "/x",
      withJsonBody(TestSchema, ({ c, body }) => c.json({ received: body })),
    );

    const res = await app.request("/x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "" }),
    });

    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    const body = await res.json();
    expect(body.error).toBe("validation_failed");
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.issues[0].path).toEqual(["name"]);
  });
});

describe("parseJsonBody", () => {
  it("should return typed data on a schema-valid JSON body", async () => {
    const app = new Hono();
    app.post("/x", async (c) => {
      const parsed = await parseJsonBody(c, TestSchema);
      if (!parsed.ok) return parsed.response;
      return c.json({ received: parsed.data });
    });

    const res = await app.request("/x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "bob" }),
    });

    expect(res.status).toBe(StatusCodes.OK);
    expect(await res.json()).toEqual({ received: { name: "bob" } });
  });

  it("should 400 invalid_body on malformed JSON", async () => {
    const app = new Hono();
    app.post("/x", async (c) => {
      const parsed = await parseJsonBody(c, TestSchema);
      if (!parsed.ok) return parsed.response;
      return c.json({ received: parsed.data });
    });

    const res = await app.request("/x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });

    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    expect(await res.json()).toEqual({ error: "invalid_body" });
  });
});

describe("parseOptionalJsonBody", () => {
  it("should default to {} and validate against the schema when the body is empty", async () => {
    const OptionalSchema = z.object({ name: z.string().default("anonymous") });
    const app = new Hono();
    app.post("/x", async (c) => {
      const parsed = await parseOptionalJsonBody(c, OptionalSchema);
      if (!parsed.ok) return parsed.response;
      return c.json({ received: parsed.data });
    });

    const res = await app.request("/x", { method: "POST" });

    expect(res.status).toBe(StatusCodes.OK);
    expect(await res.json()).toEqual({ received: { name: "anonymous" } });
  });

  it("should 400 invalid_body on malformed (non-empty, non-JSON) body", async () => {
    const app = new Hono();
    app.post("/x", async (c) => {
      const parsed = await parseOptionalJsonBody(c, TestSchema);
      if (!parsed.ok) return parsed.response;
      return c.json({ received: parsed.data });
    });

    const res = await app.request("/x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });

    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    expect(await res.json()).toEqual({ error: "invalid_body" });
  });

  it("should 400 validation_failed with issues when the provided body fails the schema", async () => {
    const app = new Hono();
    app.post("/x", async (c) => {
      const parsed = await parseOptionalJsonBody(c, TestSchema);
      if (!parsed.ok) return parsed.response;
      return c.json({ received: parsed.data });
    });

    const res = await app.request("/x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "" }),
    });

    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    const body = await res.json();
    expect(body.error).toBe("validation_failed");
    expect(Array.isArray(body.issues)).toBe(true);
  });
});

describe("handleRouteError", () => {
  it("should log the message and return a generic 500 without leaking it in the body", async () => {
    const app = new Hono();
    app.get("/x", (c) =>
      handleRouteError(c, "[events] boom", { eventId: "e1" }, new Error("secret table name")),
    );
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const res = await app.request("/x");

    expect(res.status).toBe(StatusCodes.INTERNAL_SERVER_ERROR);
    expect(await res.json()).toEqual({ error: "internal_error" });
    expect(spy).toHaveBeenCalledWith(
      "[events] boom",
      expect.objectContaining({ eventId: "e1", message: "secret table name" }),
    );
    spy.mockRestore();
  });

  it("should fall back to 'unknown error' in the log when the thrown value is not an Error", async () => {
    const app = new Hono();
    app.get("/x", (c) => handleRouteError(c, "[events] boom", {}, "raw string throw"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await app.request("/x");

    expect(spy).toHaveBeenCalledWith(
      "[events] boom",
      expect.objectContaining({ message: "unknown error" }),
    );
    spy.mockRestore();
  });
});

describe("requireEventOwnership", () => {
  it("should return undefined (pass) when the event belongs to the tenant", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: { tenantId: "t1" } });
    const app = new Hono();
    app.get("/x", async (c) => {
      const denied = await requireEventOwnership({
        c,
        shared,
        eventId: VALID_ULID,
        tenantId: "t1",
      });
      if (denied) return denied;
      return c.json({ ok: true });
    });

    const res = await app.request("/x");

    expect(res.status).toBe(StatusCodes.OK);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("should 404 not_found when the event belongs to a different tenant", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: { tenantId: "other-tenant" } });
    const app = new Hono();
    app.get("/x", async (c) => {
      const denied = await requireEventOwnership({
        c,
        shared,
        eventId: VALID_ULID,
        tenantId: "t1",
      });
      if (denied) return denied;
      return c.json({ ok: true });
    });

    const res = await app.request("/x");

    expect(res.status).toBe(StatusCodes.NOT_FOUND);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("should 404 not_found when the event row does not exist", async () => {
    const { shared, ddbSend } = buildShared();
    ddbSend.mockResolvedValueOnce({ Item: undefined });
    const app = new Hono();
    app.get("/x", async (c) => {
      const denied = await requireEventOwnership({
        c,
        shared,
        eventId: VALID_ULID,
        tenantId: "t1",
      });
      if (denied) return denied;
      return c.json({ ok: true });
    });

    const res = await app.request("/x");

    expect(res.status).toBe(StatusCodes.NOT_FOUND);
  });
});
