import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { StatusCodes } from "http-status-codes";
import { describe, expect, it } from "vitest";
import {
  copyProxyHeaders,
  createLocalChallengeProxyMiddleware,
  handleProxyError,
  parseLocalChallengeProxyUrl,
  proxyResponseBody,
  proxyStatusCode,
  rewriteLoopbackLocationHeader,
  rewriteLoopbackUrlPrefixes,
  rewritesBody,
} from "../local-play-proxy";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  return (server.address() as AddressInfo).port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function createResponseStub(headersSent = false) {
  const headers = new Map<string, string | readonly string[] | number>();
  let body = "";
  let destroyedWith: unknown;
  const res = {
    headersSent,
    statusCode: StatusCodes.OK,
    destroy(error?: Error) {
      destroyedWith = error;
      return this as unknown as ServerResponse;
    },
    end(chunk?: string | Buffer) {
      body = chunk === undefined ? "" : String(chunk);
      return this as unknown as ServerResponse;
    },
    getHeader(name: string) {
      return headers.get(name.toLowerCase());
    },
    setHeader(name: string, value: string | readonly string[] | number) {
      headers.set(name.toLowerCase(), value);
      return this as unknown as ServerResponse;
    },
    get body() {
      return body;
    },
    get destroyedWith() {
      return destroyedWith;
    },
  };
  return res as ServerResponse & {
    readonly body: string;
    readonly destroyedWith: unknown;
  };
}

describe("local play challenge proxy", () => {
  it("should parse a local challenge proxy URL", () => {
    expect(parseLocalChallengeProxyUrl("/__tenkacloud-local-port/18180/admin?q=flag")).toEqual({
      port: 18180,
      path: "/admin?q=flag",
    });
  });

  it("should route a bare port to the challenge root", () => {
    expect(parseLocalChallengeProxyUrl("/__tenkacloud-local-port/18180")).toEqual({
      port: 18180,
      path: "/",
    });
  });

  it("should preserve a query directly after the port", () => {
    expect(parseLocalChallengeProxyUrl("/__tenkacloud-local-port/18180?q=flag")).toEqual({
      port: 18180,
      path: "/?q=flag",
    });
  });

  it("should reject invalid proxy URLs", () => {
    expect(parseLocalChallengeProxyUrl(undefined)).toBeUndefined();
    expect(parseLocalChallengeProxyUrl("/problems")).toBeUndefined();
    expect(parseLocalChallengeProxyUrl("/__tenkacloud-local-port/0/")).toBeUndefined();
    expect(parseLocalChallengeProxyUrl("/__tenkacloud-local-port/not-a-port/")).toBeUndefined();
    expect(parseLocalChallengeProxyUrl("/__tenkacloud-local-port/70000/")).toBeUndefined();
  });

  it("should rewrite loopback Location headers through the same proxy", () => {
    expect(rewriteLoopbackLocationHeader("http://127.0.0.1:18180/login")).toBe(
      "/__tenkacloud-local-port/18180/login",
    );
    expect(rewriteLoopbackLocationHeader("http://localhost:18280/search?q=x")).toBe(
      "/__tenkacloud-local-port/18280/search?q=x",
    );
  });

  it("should rewrite loopback URLs embedded in challenge HTML", () => {
    expect(
      rewriteLoopbackUrlPrefixes(
        '<a href="http://127.0.0.1:18180/admin">admin</a><script src="http://localhost:18180/app.js"></script>',
      ),
    ).toBe(
      '<a href="/__tenkacloud-local-port/18180/admin">admin</a><script src="/__tenkacloud-local-port/18180/app.js"></script>',
    );
  });

  it("should support a custom forwarded prefix when rewriting loopback URLs", () => {
    expect(rewriteLoopbackUrlPrefixes("http://localhost:18180/admin", "/proxy")).toBe(
      "/proxy/18180/admin",
    );
  });

  it("should identify body content types that can be rewritten", () => {
    expect(rewritesBody({ "content-type": "text/html; charset=utf-8" })).toBe(true);
    expect(rewritesBody({ "content-encoding": "identity", "content-type": "text/css" })).toBe(true);
    expect(rewritesBody({ "content-type": "application/javascript" })).toBe(true);
    expect(rewritesBody({ "content-type": "application/json" })).toBe(true);
    expect(rewritesBody({ "content-type": "application/octet-stream" })).toBe(false);
    expect(rewritesBody({ "content-encoding": "gzip", "content-type": "text/html" })).toBe(false);
    expect(rewritesBody({})).toBe(false);
  });

  it("should copy proxy headers and rewrite loopback redirects", () => {
    const res = createResponseStub();

    copyProxyHeaders(
      {
        "content-length": "64",
        "content-type": "text/html",
        location: ["http://localhost:18180/login"],
        "x-empty": undefined,
        "x-request-id": "request-1",
      } as unknown as IncomingMessage["headers"],
      res,
    );

    expect(res.getHeader("content-length")).toBeUndefined();
    expect(res.getHeader("content-type")).toBe("text/html");
    expect(res.getHeader("location")).toBe("/__tenkacloud-local-port/18180/login");
    expect(res.getHeader("x-empty")).toBeUndefined();
    expect(res.getHeader("x-request-id")).toBe("request-1");
  });

  it("should preserve content length for non-rewritten bodies", () => {
    const res = createResponseStub();

    copyProxyHeaders(
      {
        "content-length": "4",
        "content-type": "application/octet-stream",
        location: [],
      } as unknown as IncomingMessage["headers"],
      res,
    );

    expect(res.getHeader("content-length")).toBe("4");
    expect(res.getHeader("location")).toBeUndefined();
  });

  it("should derive proxy status codes for missing upstream statuses", () => {
    expect(proxyStatusCode(StatusCodes.CREATED)).toBe(StatusCodes.CREATED);
    expect(proxyStatusCode(undefined)).toBe(StatusCodes.BAD_GATEWAY);
  });

  it("should write proxy errors before headers are sent", () => {
    const res = createResponseStub();
    const error = new Error("boom") as NodeJS.ErrnoException;
    error.code = "EHOSTUNREACH";

    handleProxyError(error, res, 18180);

    expect(res.statusCode).toBe(StatusCodes.INTERNAL_SERVER_ERROR);
    expect(res.getHeader("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.body).toContain("Local challenge proxy failed for port 18180: boom");
  });

  it("should destroy the response when a proxy error happens after headers are sent", () => {
    const res = createResponseStub(true);
    const error = new Error("late failure") as NodeJS.ErrnoException;

    handleProxyError(error, res, 18180);

    expect(res.destroyedWith).toBe(error);
  });

  it("should pipe non-rewritten upstream response bodies", () => {
    const upstreamRes = {
      headers: { "content-type": "application/octet-stream" },
      pipe: (res: ServerResponse) => res,
    } as IncomingMessage;
    const res = createResponseStub();

    expect(proxyResponseBody(upstreamRes, res)).toBeUndefined();
  });

  it("should rewrite string chunks in upstream response bodies", () => {
    const upstreamRes = new EventEmitter() as IncomingMessage;
    upstreamRes.headers = { "content-type": "text/html" };
    const res = createResponseStub();

    proxyResponseBody(upstreamRes, res);
    upstreamRes.emit("data", "http://localhost:18180/admin");
    upstreamRes.emit("end");

    expect(res.body).toBe("/__tenkacloud-local-port/18180/admin");
  });

  it("should call the next middleware for non-proxy requests", async () => {
    const middleware = createLocalChallengeProxyMiddleware();
    const proxy = createServer((req, res) => {
      middleware(req, res, () => {
        res.statusCode = StatusCodes.NOT_FOUND;
        res.end("next middleware");
      });
    });
    const proxyPort = await listen(proxy);

    try {
      const res = await fetch(`http://127.0.0.1:${proxyPort}/not-a-proxy-route`);

      expect(res.status).toBe(StatusCodes.NOT_FOUND);
      expect(await res.text()).toBe("next middleware");
    } finally {
      await close(proxy);
    }
  });

  it("should proxy local challenge responses through the participant portal origin", async () => {
    let upstreamPort = 0;
    const upstream = createServer((req, res) => {
      const body = `<a href="http://127.0.0.1:${upstreamPort}/admin">admin</a>`;
      expect(req.method).toBe("POST");
      expect(req.url).toBe("/admin?q=flag");
      expect(req.headers.host).toBe(`127.0.0.1:${upstreamPort}`);
      expect(req.headers["accept-encoding"]).toBe("identity");
      res.statusCode = StatusCodes.CREATED;
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.setHeader("content-length", String(Buffer.byteLength(body)));
      res.setHeader("location", `http://127.0.0.1:${upstreamPort}/login`);
      res.end(body);
    });
    upstreamPort = await listen(upstream);
    const middleware = createLocalChallengeProxyMiddleware();
    const proxy = createServer((req, res) => {
      middleware(req, res, () => {
        res.statusCode = StatusCodes.NOT_FOUND;
        res.end("unhandled");
      });
    });
    const proxyPort = await listen(proxy);

    try {
      const res = await fetch(
        `http://127.0.0.1:${proxyPort}/__tenkacloud-local-port/${upstreamPort}/admin?q=flag`,
        { body: "payload", method: "POST" },
      );
      const expectedBody = `<a href="/__tenkacloud-local-port/${upstreamPort}/admin">admin</a>`;

      expect(res.status).toBe(StatusCodes.CREATED);
      expect(res.headers.get("content-length")).toBe(String(Buffer.byteLength(expectedBody)));
      expect(res.headers.get("location")).toBe(`/__tenkacloud-local-port/${upstreamPort}/login`);
      expect(await res.text()).toBe(expectedBody);
    } finally {
      await close(proxy);
      await close(upstream);
    }
  });

  it("should return bad gateway when the local challenge port is unavailable", async () => {
    const closedServer = createServer();
    const unavailablePort = await listen(closedServer);
    await close(closedServer);
    const middleware = createLocalChallengeProxyMiddleware();
    const proxy = createServer((req, res) => {
      middleware(req, res, () => {
        res.statusCode = StatusCodes.NOT_FOUND;
        res.end("unhandled");
      });
    });
    const proxyPort = await listen(proxy);

    try {
      const res = await fetch(
        `http://127.0.0.1:${proxyPort}/__tenkacloud-local-port/${unavailablePort}/`,
      );

      expect(res.status).toBe(StatusCodes.BAD_GATEWAY);
      expect(await res.text()).toContain(
        `Local challenge proxy failed for port ${unavailablePort}:`,
      );
    } finally {
      await close(proxy);
    }
  });
});
