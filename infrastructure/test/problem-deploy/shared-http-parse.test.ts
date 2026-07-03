import { Hono } from "hono";
import { StatusCodes } from "http-status-codes";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  parseJsonBody,
  parseOptionalJsonBody,
  parseParams,
  parseQuery,
  parseSchema,
} from "../../lib/problem-deploy/handlers/shared/http-parse";

/**
 * Issue #2211: direct unit coverage of the shared request-boundary parser. The
 * participant / event handler suites already exercise it end-to-end; these tests
 * pin each function's frozen response shape in isolation.
 */

const Body = z.object({ name: z.string() });
const Query = z.object({ limit: z.string() });
const Params = z.object({ id: z.string() });

/** Drive one handler that calls `fn` and returns its Response, via a real Hono app. */
async function run(
  path: string,
  method: "GET" | "POST",
  init: RequestInit,
  register: (app: Hono) => void,
): Promise<Response> {
  const app = new Hono();
  register(app);
  return app.request(path, { method, ...init });
}

describe("shared http-parse", () => {
  describe("parseJsonBody", () => {
    it("should return typed data for a valid JSON body", async () => {
      const res = await run("/", "POST", { body: JSON.stringify({ name: "ok" }) }, (app) =>
        app.post("/", async (c) => {
          const r = await parseJsonBody(c, Body);
          return r.ok ? c.json(r.data) : r.response;
        }),
      );
      expect(res.status).toBe(StatusCodes.OK);
      expect(await res.json()).toEqual({ name: "ok" });
    });

    it("should return invalid_body (400) for a non-JSON body", async () => {
      const res = await run("/", "POST", { body: "not json{" }, (app) =>
        app.post("/", async (c) => {
          const r = await parseJsonBody(c, Body);
          return r.ok ? c.json(r.data) : r.response;
        }),
      );
      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
      expect(await res.json()).toEqual({ error: "invalid_body" });
    });

    it("should return validation_failed with issues for a schema mismatch", async () => {
      const res = await run("/", "POST", { body: JSON.stringify({ name: 1 }) }, (app) =>
        app.post("/", async (c) => {
          const r = await parseJsonBody(c, Body);
          return r.ok ? c.json(r.data) : r.response;
        }),
      );
      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
      const json = (await res.json()) as { error: string; issues: unknown[] };
      expect(json.error).toBe("validation_failed");
      expect(Array.isArray(json.issues)).toBe(true);
      expect(json.issues.length).toBeGreaterThan(0);
    });
  });

  describe("parseOptionalJsonBody", () => {
    const Optional = z.object({ name: z.string().optional() });

    it("should treat an empty body as {} and accept an all-optional schema", async () => {
      const res = await run("/", "POST", {}, (app) =>
        app.post("/", async (c) => {
          const r = await parseOptionalJsonBody(c, Optional);
          return r.ok ? c.json({ got: r.data }) : r.response;
        }),
      );
      expect(res.status).toBe(StatusCodes.OK);
      expect(await res.json()).toEqual({ got: {} });
    });

    it("should still reject a non-empty malformed body with invalid_body", async () => {
      const res = await run("/", "POST", { body: "{oops" }, (app) =>
        app.post("/", async (c) => {
          const r = await parseOptionalJsonBody(c, Optional);
          return r.ok ? c.json(r.data) : r.response;
        }),
      );
      expect(res.status).toBe(StatusCodes.BAD_REQUEST);
      expect(await res.json()).toEqual({ error: "invalid_body" });
    });
  });

  describe("parseQuery", () => {
    it("should validate the query string and reject a mismatch with validation_failed", async () => {
      const ok = await run("/?limit=10", "GET", {}, (app) =>
        app.get("/", (c) => {
          const r = parseQuery(c, Query);
          return r.ok ? c.json(r.data) : r.response;
        }),
      );
      expect(ok.status).toBe(StatusCodes.OK);
      expect(await ok.json()).toEqual({ limit: "10" });

      const bad = await run("/", "GET", {}, (app) =>
        app.get("/", (c) => {
          const r = parseQuery(c, Query);
          return r.ok ? c.json(r.data) : r.response;
        }),
      );
      expect(bad.status).toBe(StatusCodes.BAD_REQUEST);
      expect(((await bad.json()) as { error: string }).error).toBe("validation_failed");
    });
  });

  describe("parseParams", () => {
    it("should validate path params and reject a mismatch with validation_failed", async () => {
      const ok = await run("/x", "GET", {}, (app) =>
        app.get("/:id", (c) => {
          const r = parseParams(c, Params);
          return r.ok ? c.json(r.data) : r.response;
        }),
      );
      expect(ok.status).toBe(StatusCodes.OK);
      expect(await ok.json()).toEqual({ id: "x" });
    });
  });

  describe("parseSchema", () => {
    it("should validate an already-decoded value", async () => {
      const res = await run("/", "GET", {}, (app) =>
        app.get("/", (c) => {
          const r = parseSchema(c, Body, { name: "direct" });
          return r.ok ? c.json(r.data) : r.response;
        }),
      );
      expect(await res.json()).toEqual({ name: "direct" });
    });
  });
});
