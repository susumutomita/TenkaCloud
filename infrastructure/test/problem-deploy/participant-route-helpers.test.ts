import { Hono } from "hono";
import { StatusCodes } from "http-status-codes";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  parseJsonBody,
  parseParams,
  parseQuery,
  respondError,
  withBearerAuth,
} from "../../lib/problem-deploy/handlers/participant-handler/route-helpers";
import { RATE_LIMITS } from "../../lib/problem-deploy/handlers/shared/rate-limiter";

/**
 * Issue #2196 (RC-21 第1弾): participant-handler `route-helpers.ts` の共有プラミングは
 * 多数のルートが依存するのに専用テストが無かった。 `invalid_body` / `validation_failed` +
 * `issues` の JSON 形状はフロントとの実質契約なので、 統合リファクタ (RC-21 第2弾) の前に
 * 明示的な shape assertion で固定する (スナップショットではない — 契約であることを
 * 読み手に示す)。 本体コードは変更しない。
 */

let seq = 0;
/** rate limiter は module-scope singleton なので、 test ごとに一意の token/route を使い
 *  bucket の取り合いを避ける。 */
function uniqueRoute(): string {
  seq += 1;
  return `route-helpers-test-${seq}`;
}

/** `extractBearerToken` は teamLoginKey 形式 (43 文字の base64url-like) のみ受理する。 */
const VALID_TOKEN = "a".repeat(43);

describe("respondError", () => {
  it("should map a known error kind to its HTTP status with just the error code", async () => {
    const app = new Hono();
    app.get("/x", (c) => respondError(c, "unauthorized"));

    const res = await app.request("/x");

    expect(res.status).toBe(StatusCodes.UNAUTHORIZED);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("should include extras in the body when provided (non-empty object)", async () => {
    const app = new Hono();
    app.get("/x", (c) =>
      respondError(c, "scoring_not_started", { startsAt: "2026-01-01T00:00:00Z" }),
    );

    const res = await app.request("/x");

    expect(res.status).toBe(StatusCodes.CONFLICT);
    expect(await res.json()).toEqual({
      error: "scoring_not_started",
      startsAt: "2026-01-01T00:00:00Z",
    });
  });

  it("should omit extras from the body when the extras object is empty", async () => {
    const app = new Hono();
    app.get("/x", (c) => respondError(c, "not_found", {}));

    const res = await app.request("/x");

    expect(await res.json()).toEqual({ error: "not_found" });
  });
});

describe("withBearerAuth", () => {
  it("should 401 unauthorized when the Authorization header is missing", async () => {
    const app = new Hono();
    const routeName = uniqueRoute();
    app.get("/x", (c) => withBearerAuth(c, routeName, async () => c.json({ ok: true })));

    const res = await app.request("/x");

    expect(res.status).toBe(StatusCodes.UNAUTHORIZED);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("should invoke the handler with the extracted bearer token on success", async () => {
    const app = new Hono();
    const routeName = uniqueRoute();
    app.get("/x", (c) =>
      withBearerAuth(c, routeName, async (token) => c.json({ token }, StatusCodes.OK)),
    );

    const res = await app.request("/x", { headers: { authorization: `Bearer ${VALID_TOKEN}` } });

    expect(res.status).toBe(StatusCodes.OK);
    expect(await res.json()).toEqual({ token: VALID_TOKEN });
  });

  it("should 500 internal_error and not leak the message when the handler throws", async () => {
    const app = new Hono();
    const routeName = uniqueRoute();
    app.get("/x", (c) =>
      withBearerAuth(c, routeName, async () => {
        throw new Error("db exploded with a secret ARN");
      }),
    );

    const res = await app.request("/x", { headers: { authorization: `Bearer ${VALID_TOKEN}` } });

    expect(res.status).toBe(StatusCodes.INTERNAL_SERVER_ERROR);
    const body = await res.json();
    expect(body).toEqual({ error: "internal_error" });
  });

  it("should 429 rate_limited with a Retry-After header once the bucket is exhausted", async () => {
    const app = new Hono();
    const routeName = uniqueRoute();
    app.get("/x", (c) =>
      withBearerAuth(c, routeName, async () => c.json({ ok: true }), RATE_LIMITS.WRITE_VERY_LOW),
    );

    // WRITE_VERY_LOW capacity=3 — drain the bucket for this (token, routeName) pair.
    for (let i = 0; i < RATE_LIMITS.WRITE_VERY_LOW.capacity; i++) {
      const ok = await app.request("/x", { headers: { authorization: `Bearer ${VALID_TOKEN}` } });
      expect(ok.status).toBe(StatusCodes.OK);
    }

    const res = await app.request("/x", { headers: { authorization: `Bearer ${VALID_TOKEN}` } });

    expect(res.status).toBe(StatusCodes.TOO_MANY_REQUESTS);
    const body = await res.json();
    expect(body.error).toBe("rate_limited");
    expect(typeof body.retryAfterSec).toBe("number");
    expect(res.headers.get("Retry-After")).toBe(String(body.retryAfterSec));
  });
});

const TestSchema = z.object({ name: z.string().min(1) });

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
      body: JSON.stringify({ name: "alice" }),
    });

    expect(res.status).toBe(StatusCodes.OK);
    expect(await res.json()).toEqual({ received: { name: "alice" } });
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

  it("should 400 validation_failed with flattened zod issues on a schema mismatch", async () => {
    const app = new Hono();
    app.post("/x", async (c) => {
      const parsed = await parseJsonBody(c, TestSchema);
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
    expect(body.issues.length).toBeGreaterThan(0);
    expect(body.issues[0].path).toEqual(["name"]);
  });
});

describe("parseQuery", () => {
  const QuerySchema = z.object({ sinceMin: z.coerce.number().int().positive() });

  it("should return typed data on a schema-valid query string", async () => {
    const app = new Hono();
    app.get("/x", (c) => {
      const parsed = parseQuery(c, QuerySchema);
      if (!parsed.ok) return parsed.response;
      return c.json({ received: parsed.data });
    });

    const res = await app.request("/x?sinceMin=5");

    expect(res.status).toBe(StatusCodes.OK);
    expect(await res.json()).toEqual({ received: { sinceMin: 5 } });
  });

  it("should 400 validation_failed with issues when the query does not match the schema", async () => {
    const app = new Hono();
    app.get("/x", (c) => {
      const parsed = parseQuery(c, QuerySchema);
      if (!parsed.ok) return parsed.response;
      return c.json({ received: parsed.data });
    });

    const res = await app.request("/x?sinceMin=not-a-number");

    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    const body = await res.json();
    expect(body.error).toBe("validation_failed");
    expect(Array.isArray(body.issues)).toBe(true);
  });
});

describe("parseParams", () => {
  const ParamsSchema = z.object({ jobId: z.string().min(1) });

  it("should return typed data on a schema-valid path param", async () => {
    const app = new Hono();
    app.get("/x/:jobId", (c) => {
      const parsed = parseParams(c, ParamsSchema);
      if (!parsed.ok) return parsed.response;
      return c.json({ received: parsed.data });
    });

    const res = await app.request("/x/job-123");

    expect(res.status).toBe(StatusCodes.OK);
    expect(await res.json()).toEqual({ received: { jobId: "job-123" } });
  });

  it("should 400 validation_failed with issues when a required path param is missing", async () => {
    const app = new Hono();
    const StrictParamsSchema = z.object({ jobId: z.string().min(1), extra: z.string().min(1) });
    app.get("/x/:jobId", (c) => {
      const parsed = parseParams(c, StrictParamsSchema);
      if (!parsed.ok) return parsed.response;
      return c.json({ received: parsed.data });
    });

    const res = await app.request("/x/job-123");

    expect(res.status).toBe(StatusCodes.BAD_REQUEST);
    const body = await res.json();
    expect(body.error).toBe("validation_failed");
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.issues.some((i: { path: string[] }) => i.path.includes("extra"))).toBe(true);
  });
});
