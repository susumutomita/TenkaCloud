import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { StatusCodes } from "http-status-codes";
import { describe, expect, it, vi } from "vitest";
import {
  createLocalApiProxyMiddleware,
  LOCAL_API_PROXY_PREFIX,
  localApiProxyTimeoutMs,
  localApiRequestHeaders,
  parseLocalApiProxyUrl,
  resolveLocalApiTarget,
} from "../local-play-proxy";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function statePath(apiBaseUrl: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "tc-local-api-proxy-")), "state.json");
  writeFileSync(path, JSON.stringify({ apiBaseUrl }));
  return path;
}

function proxyServer(path: string, timeoutMs?: number): Server {
  const middleware = createLocalApiProxyMiddleware({ statePath: path, timeoutMs });
  return createServer((request, response) => {
    middleware(request, response, () => {
      response.writeHead(StatusCodes.NOT_FOUND);
      response.end("not proxied");
    });
  });
}

function mockResponse(headersSent = false): {
  readonly done: Promise<void>;
  readonly response: ServerResponse;
  readonly status: () => number | undefined;
  readonly body: () => string | undefined;
  readonly destroy: ReturnType<typeof vi.fn>;
} {
  let accept!: () => void;
  let status: number | undefined;
  let body: string | undefined;
  const done = new Promise<void>((resolve) => {
    accept = resolve;
  });
  const destroy = vi.fn(() => accept());
  const response = {
    headersSent,
    setHeader: vi.fn(),
    writeHead: vi.fn((nextStatus: number) => {
      status = nextStatus;
    }),
    end: vi.fn((value?: Buffer | string) => {
      body = value?.toString();
      accept();
    }),
    destroy,
  } as unknown as ServerResponse;
  return { done, response, status: () => status, body: () => body, destroy };
}

function mockIncoming(
  url: string,
  headers: IncomingMessage["headers"] = {},
  asText = false,
): PassThrough & IncomingMessage {
  const stream = new PassThrough();
  if (asText) stream.setEncoding("utf8");
  return Object.assign(stream, { headers, method: "POST", url }) as PassThrough & IncomingMessage;
}

describe("Codespaces local Participant API proxy", () => {
  it("should allow only health and participant API routes below the fixed prefix", () => {
    expect(parseLocalApiProxyUrl("/__tenkacloud-local-api/healthz")).toBe("/healthz");
    expect(parseLocalApiProxyUrl("/__tenkacloud-local-api/portal/me?fresh=1")).toBe(
      "/portal/me?fresh=1",
    );
    expect(
      parseLocalApiProxyUrl("/__tenkacloud-local-api/local/operator/snapshot"),
    ).toBeUndefined();
    expect(parseLocalApiProxyUrl("/__tenkacloud-local-port/18180/")).toBeUndefined();
    expect(parseLocalApiProxyUrl(LOCAL_API_PROXY_PREFIX)).toBeUndefined();
    expect(parseLocalApiProxyUrl(undefined)).toBeUndefined();
  });

  it("should resolve only an exact loopback API origin from local session state", () => {
    expect(resolveLocalApiTarget(statePath("http://127.0.0.1:43199"))?.origin).toBe(
      "http://127.0.0.1:43199",
    );
    expect(resolveLocalApiTarget(statePath("https://attacker.example"))).toBeUndefined();
    expect(resolveLocalApiTarget(statePath("http://attacker.example:43199"))).toBeUndefined();
    expect(resolveLocalApiTarget(statePath("http://127.0.0.1"))).toBeUndefined();
    expect(resolveLocalApiTarget(statePath("http://user:secret@127.0.0.1:43199"))).toBeUndefined();
    expect(resolveLocalApiTarget(statePath("http://127.0.0.1:43199/path"))).toBeUndefined();
    expect(resolveLocalApiTarget(statePath("http://127.0.0.1:43199?query=1"))).toBeUndefined();
    expect(resolveLocalApiTarget(statePath("http://127.0.0.1:43199#fragment"))).toBeUndefined();
    expect(resolveLocalApiTarget(statePath("http://localhost:43199"))?.hostname).toBe("localhost");
  });

  it("should fail closed for missing or malformed local session state", () => {
    const directory = mkdtempSync(join(tmpdir(), "tc-local-api-proxy-state-"));
    const missing = join(directory, "missing.json");
    const malformed = join(directory, "malformed.json");
    const wrongShape = join(directory, "wrong-shape.json");
    writeFileSync(malformed, "{");
    writeFileSync(wrongShape, JSON.stringify({ apiBaseUrl: 43199 }));

    expect(resolveLocalApiTarget(missing)).toBeUndefined();
    expect(resolveLocalApiTarget(malformed)).toBeUndefined();
    expect(resolveLocalApiTarget(wrongShape)).toBeUndefined();
  });

  it("should resolve the default state path with and without a local directory override", () => {
    const original = process.env.TENKACLOUD_LOCAL_DIR;
    const directory = mkdtempSync(join(tmpdir(), "tc-local-api-proxy-default-"));
    writeFileSync(
      join(directory, "state.json"),
      JSON.stringify({ apiBaseUrl: "http://127.0.0.1:43199" }),
    );
    try {
      process.env.TENKACLOUD_LOCAL_DIR = directory;
      expect(resolveLocalApiTarget()?.origin).toBe("http://127.0.0.1:43199");
      delete process.env.TENKACLOUD_LOCAL_DIR;
      expect(resolveLocalApiTarget()?.protocol).not.toBe("https:");
    } finally {
      if (original === undefined) delete process.env.TENKACLOUD_LOCAL_DIR;
      else process.env.TENKACLOUD_LOCAL_DIR = original;
    }
  });

  it("should strip browser and forwarding identity while preserving the bearer", () => {
    expect(
      localApiRequestHeaders(
        {
          authorization: "Bearer participant-token",
          cookie: "github_auth=secret",
          cookie2: "legacy=secret",
          forwarded: "for=203.0.113.5",
          origin: "https://demo-5175.app.github.dev",
          "cf-connecting-ip": "203.0.113.5",
          "x-forwarded-host": "demo-5175.app.github.dev",
          "x-github-user": "octocat",
          "x-original-url": "/private",
        },
        new URL("http://127.0.0.1:43199"),
      ),
    ).toEqual({
      "accept-encoding": "identity",
      authorization: "Bearer participant-token",
      host: "127.0.0.1:43199",
    });
  });

  it("should reserve the long timeout for lifecycle mutations", () => {
    for (const action of ["start", "stop", "reset"]) {
      expect(localApiProxyTimeoutMs(`/portal/me/problems/p/${action}`, "POST")).toBe(180_000);
    }
    expect(localApiProxyTimeoutMs("/portal/me/problems/p/start", "GET")).toBe(15_000);
    expect(localApiProxyTimeoutMs("/portal/me/problems/p/score", "POST")).toBe(15_000);
  });

  it("should reject an excessive number of forwarded headers", () => {
    const headers = Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [`x-portal-${index}`, String(index)]),
    );
    expect(() => localApiRequestHeaders(headers, new URL("http://127.0.0.1:43199"))).toThrow(
      "local_api_proxy_headers_too_large",
    );
  });

  it("should forward a Codespaces runtime mutation without leaking browser identity", async () => {
    let observed: Record<string, unknown> | undefined;
    const upstream = createServer((request, response) => {
      observed = {
        authorization: request.headers.authorization,
        cookie: request.headers.cookie,
        github: request.headers["x-github-user"],
        method: request.method,
        origin: request.headers.origin,
        path: request.url,
      };
      response.writeHead(StatusCodes.SEE_OTHER, {
        location: "https://demo-43210.app.github.dev/console#token=fragment",
        "service-worker-allowed": "/",
        "set-cookie": "simulator=secret",
      });
      response.end();
    });
    const upstreamPort = await listen(upstream);
    const proxy = proxyServer(statePath(`http://127.0.0.1:${upstreamPort}`));
    const proxyPort = await listen(proxy);
    try {
      const response = await fetch(
        `http://127.0.0.1:${proxyPort}/__tenkacloud-local-api/portal/me/problems/p/start`,
        {
          headers: {
            authorization: "Bearer participant-token",
            cookie: "github_auth=secret",
            origin: "https://demo-5175.app.github.dev",
            "x-github-user": "octocat",
          },
          method: "POST",
          redirect: "manual",
        },
      );
      expect(response.status).toBe(StatusCodes.SEE_OTHER);
      expect(response.headers.get("location")).toBe(
        "https://demo-43210.app.github.dev/console#token=fragment",
      );
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(response.headers.get("service-worker-allowed")).toBeNull();
      expect(observed).toEqual({
        authorization: "Bearer participant-token",
        cookie: undefined,
        github: undefined,
        method: "POST",
        origin: undefined,
        path: "/portal/me/problems/p/start",
      });
    } finally {
      await close(proxy);
      await close(upstream);
    }
  });

  it("should bound upstream responses and time out stalled requests", async () => {
    const oversized = createServer((_request, response) => {
      response.end(Buffer.alloc(1_000_001, "x"));
    });
    const oversizedPort = await listen(oversized);
    const oversizedProxy = proxyServer(statePath(`http://127.0.0.1:${oversizedPort}`));
    const oversizedProxyPort = await listen(oversizedProxy);
    try {
      const response = await fetch(
        `http://127.0.0.1:${oversizedProxyPort}/__tenkacloud-local-api/portal/me`,
      );
      expect(response.status).toBe(StatusCodes.REQUEST_TOO_LONG);
    } finally {
      await close(oversizedProxy);
      await close(oversized);
    }

    const stalled = createServer(() => {});
    const stalledPort = await listen(stalled);
    const stalledProxy = proxyServer(statePath(`http://127.0.0.1:${stalledPort}`), 20);
    const stalledProxyPort = await listen(stalledProxy);
    try {
      const response = await fetch(
        `http://127.0.0.1:${stalledProxyPort}/__tenkacloud-local-api/portal/me`,
      );
      expect(response.status).toBe(StatusCodes.GATEWAY_TIMEOUT);
      expect(await response.json()).toEqual({ error: "local_api_proxy_timeout" });
    } finally {
      await close(stalledProxy);
      await close(stalled);
    }
  });

  it("should forward a text request body and preserve a missing upstream status fallback", async () => {
    let observedBody = "";
    const upstream = createServer((request, response) => {
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        observedBody += chunk;
      });
      request.on("end", () => response.end("ok"));
    });
    const upstreamPort = await listen(upstream);
    const middleware = createLocalApiProxyMiddleware({
      statePath: statePath(`http://127.0.0.1:${upstreamPort}`),
    });
    const incoming = mockIncoming(`${LOCAL_API_PROXY_PREFIX}/portal/me`, {}, true);
    const captured = mockResponse();
    try {
      middleware(incoming, captured.response, vi.fn());
      incoming.end("hello simulator");
      await captured.done;
      expect(observedBody).toBe("hello simulator");
      expect(captured.body()).toBe("ok");
    } finally {
      await close(upstream);
    }
  });

  it("should return explicit errors for an unavailable target and excessive headers", async () => {
    const unavailable = proxyServer(join(tmpdir(), "tc-local-api-proxy-missing-state.json"));
    const unavailablePort = await listen(unavailable);
    try {
      const response = await fetch(
        `http://127.0.0.1:${unavailablePort}${LOCAL_API_PROXY_PREFIX}/portal/me`,
      );
      expect(response.status).toBe(StatusCodes.BAD_GATEWAY);
    } finally {
      await close(unavailable);
    }

    const upstream = createServer((_request, response) => response.end("unused"));
    const upstreamPort = await listen(upstream);
    const middleware = createLocalApiProxyMiddleware({
      statePath: statePath(`http://127.0.0.1:${upstreamPort}`),
    });
    const headers = Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [`x-portal-${index}`, String(index)]),
    );
    const incoming = mockIncoming(`${LOCAL_API_PROXY_PREFIX}/portal/me`, headers);
    const captured = mockResponse();
    try {
      middleware(incoming, captured.response, vi.fn());
      incoming.end();
      await captured.done;
      expect(captured.status()).toBe(StatusCodes.BAD_REQUEST);
      expect(JSON.parse(captured.body() ?? "{}")).toEqual({
        error: "local_api_proxy_headers_too_large",
      });
    } finally {
      await close(upstream);
    }
  });

  it("should delegate requests outside the fixed proxy prefix", async () => {
    const server = proxyServer(statePath("http://127.0.0.1:43199"));
    const port = await listen(server);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/outside`);
      expect(response.status).toBe(StatusCodes.NOT_FOUND);
      expect(await response.text()).toBe("not proxied");
    } finally {
      await close(server);
    }
  });

  it("should destroy an already-started response for Error and non-Error failures", async () => {
    const unavailableMiddleware = createLocalApiProxyMiddleware({
      statePath: join(tmpdir(), "tc-local-api-proxy-still-missing.json"),
    });
    const unavailableRequest = mockIncoming(`${LOCAL_API_PROXY_PREFIX}/portal/me`);
    const errorResponse = mockResponse(true);
    unavailableMiddleware(unavailableRequest, errorResponse.response, vi.fn());
    unavailableRequest.end();
    await errorResponse.done;
    expect(errorResponse.destroy.mock.calls[0]?.[0]).toBeInstanceOf(Error);

    const upstream = createServer((_request, response) => response.end("unused"));
    const upstreamPort = await listen(upstream);
    const middleware = createLocalApiProxyMiddleware({
      statePath: statePath(`http://127.0.0.1:${upstreamPort}`),
    });
    const incoming = mockIncoming(`${LOCAL_API_PROXY_PREFIX}/portal/me`);
    const nonErrorResponse = mockResponse(true);
    try {
      middleware(incoming, nonErrorResponse.response, vi.fn());
      incoming.emit("error", "not-an-error");
      await nonErrorResponse.done;
      expect(nonErrorResponse.destroy).toHaveBeenCalledWith(undefined);

      const visibleErrorRequest = mockIncoming(`${LOCAL_API_PROXY_PREFIX}/portal/me`);
      const visibleErrorResponse = mockResponse();
      middleware(visibleErrorRequest, visibleErrorResponse.response, vi.fn());
      visibleErrorRequest.emit("error", "not-an-error");
      await visibleErrorResponse.done;
      expect(visibleErrorResponse.status()).toBe(StatusCodes.BAD_GATEWAY);
      expect(JSON.parse(visibleErrorResponse.body() ?? "{}")).toEqual({
        error: "local_api_proxy_failed",
      });
    } finally {
      await close(upstream);
    }
  });
});
