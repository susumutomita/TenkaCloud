import { Hono } from "hono";
import { StatusCodes } from "http-status-codes";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  parseJsonBody,
  parseParams,
  parseQuery,
} from "../../lib/problem-deploy/handlers/shared/http-parse";

/**
 * Issue #2211 (RC-21 第2弾): リクエスト境界 parse を集約した shared/http-parse の直接 test。
 * participant / event / deploy が委譲する単一実装なので、`invalid_body` / `validation_failed`
 * + `issues` の JSON 形状 (= フロント契約) をここで shape assertion として固定する。
 */

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

  it("should 400 validation_failed with the raw zod issues on a schema mismatch", async () => {
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
