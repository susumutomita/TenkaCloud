import { Hono } from "hono";
import { StatusCodes } from "http-status-codes";
import { describe, expect, it } from "vitest";
import { secureApiHeaders } from "../../../../lib/problem-deploy/handlers/shared/secure-headers.js";

/**
 * Issue #1694: execute-api (Hono on Lambda) の JSON レスポンスにセキュリティヘッダを付与する
 * 共有 middleware。 bare-Hono app に乗せて dispatch し、 付与ヘッダ / 既存ヘッダ尊重 /
 * CORS 非干渉 / onError 経路でも付くことを pin する。
 */
function buildApp() {
  const app = new Hono();
  app.use("*", secureApiHeaders());
  app.get("/json", (c) => c.json({ ok: true }, StatusCodes.OK));
  app.get("/with-cache", (c) => {
    c.header("Cache-Control", "public, max-age=60");
    return c.json({ cacheable: true }, StatusCodes.OK);
  });
  app.get("/csv", (c) => {
    c.header("Content-Type", "text/csv; charset=utf-8");
    c.header("Content-Disposition", 'attachment; filename="audit.csv"');
    return c.body("a,b\n1,2\n", StatusCodes.OK);
  });
  app.get("/text", (c) => c.text("hello", StatusCodes.OK));
  app.get("/no-content", (c) => c.body(null, StatusCodes.NO_CONTENT));
  app.get("/boom", () => {
    throw new Error("kaboom");
  });
  return app;
}

describe("secureApiHeaders (Issue #1694)", () => {
  it("should set X-Content-Type-Options: nosniff on JSON responses", async () => {
    const res = await buildApp().request("/json");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("should set X-Frame-Options: DENY", async () => {
    const res = await buildApp().request("/json");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("should set Referrer-Policy: strict-origin-when-cross-origin", async () => {
    const res = await buildApp().request("/json");
    expect(res.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  });

  it("should set Cache-Control: no-store when the route did not set one", async () => {
    const res = await buildApp().request("/json");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("should NOT override a route-level Cache-Control (cacheable opt-out)", async () => {
    const res = await buildApp().request("/with-cache");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=60");
  });

  it("should add Content-Disposition: attachment for JSON responses", async () => {
    const res = await buildApp().request("/json");
    expect(res.headers.get("Content-Disposition")).toBe("attachment");
  });

  it("should NOT override an existing Content-Disposition (CSV export preserved)", async () => {
    const res = await buildApp().request("/csv");
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="audit.csv"');
    // CSV でも nosniff / no-store は付く
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("should NOT add Content-Disposition for non-JSON responses", async () => {
    const res = await buildApp().request("/text");
    expect(res.headers.get("Content-Disposition")).toBeNull();
    // 但し nosniff / frame-options は全レスポンスに付く
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("should handle a response without a Content-Type (no Content-Disposition added)", async () => {
    const res = await buildApp().request("/no-content");
    expect(res.status).toBe(StatusCodes.NO_CONTENT);
    expect(res.headers.get("Content-Disposition")).toBeNull();
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("should still attach headers to error responses routed through onError", async () => {
    const app = buildApp();
    app.onError((_err, c) =>
      c.json({ error: "internal_error" }, StatusCodes.INTERNAL_SERVER_ERROR),
    );
    const res = await app.request("/boom");
    expect(res.status).toBe(StatusCodes.INTERNAL_SERVER_ERROR);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("should not interfere with CORS headers set by a downstream middleware", async () => {
    const app = new Hono();
    app.use("*", secureApiHeaders());
    app.use("*", async (c, next) => {
      await next();
      c.res.headers.set("Access-Control-Allow-Origin", "*");
    });
    app.get("/json", (c) => c.json({ ok: true }, StatusCodes.OK));
    const res = await app.request("/json");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});
