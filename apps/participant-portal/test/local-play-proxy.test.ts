import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StatusCodes } from "http-status-codes";
import { describe, expect, it } from "vitest";
import {
  createLocalApiProxyMiddleware,
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
  });

  it("should resolve only an exact loopback API origin from local session state", () => {
    expect(resolveLocalApiTarget(statePath("http://127.0.0.1:43199"))?.origin).toBe(
      "http://127.0.0.1:43199",
    );
    expect(resolveLocalApiTarget(statePath("https://attacker.example"))).toBeUndefined();
    expect(resolveLocalApiTarget(statePath("http://127.0.0.1:43199/path"))).toBeUndefined();
  });

  it("should strip forwarding auth material while preserving portal Origin and bearer", () => {
    expect(
      localApiRequestHeaders(
        {
          authorization: "Bearer participant-token",
          cookie: "github_auth=secret",
          origin: "https://demo-5175.app.github.dev",
          "x-forwarded-host": "demo-5175.app.github.dev",
          "x-github-user": "octocat",
        },
        new URL("http://127.0.0.1:43199"),
      ),
    ).toEqual({
      "accept-encoding": "identity",
      authorization: "Bearer participant-token",
      host: "127.0.0.1:43199",
      origin: "https://demo-5175.app.github.dev",
    });
  });

  it("should preserve participant auth, Origin, and manual redirects without leaking cookies", async () => {
    let observed: Record<string, unknown> | undefined;
    const upstream = createServer((request, response) => {
      observed = {
        authorization: request.headers.authorization,
        cookie: request.headers.cookie,
        github: request.headers["x-github-user"],
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
        `http://127.0.0.1:${proxyPort}/__tenkacloud-local-api/portal/me/problems/p/console?ticket=t`,
        {
          headers: {
            authorization: "Bearer participant-token",
            cookie: "github_auth=secret",
            origin: "https://demo-5175.app.github.dev",
            "x-github-user": "octocat",
          },
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
        origin: "https://demo-5175.app.github.dev",
        path: "/portal/me/problems/p/console?ticket=t",
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
      expect(response.status).toBe(StatusCodes.BAD_GATEWAY);
      expect(await response.json()).toEqual({ error: "local_api_proxy_failed" });
    } finally {
      await close(stalledProxy);
      await close(stalled);
    }
  });
});
