/**
 * Issue #1975: integration test for the local Participant API node:http wrapper.
 *
 * `server.ts` is thin HTTP glue around the pure router `handleLocalRequest`, so we
 * exercise it as a real (local + fast) integration test: bind on port 0 (OS-assigned
 * so parallel runs never collide), drive it with the global `fetch`, and close the
 * server in a `finally` / `afterEach` so no handles leak and the suite exits cleanly.
 */

import { EventEmitter } from "node:events";
import { type AddressInfo, createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type LocalCatalogProblem, localPracticeFlag } from "../src/local/catalog.ts";

// Partial-mock node:http so the real Server / listen / address / close are kept
// intact for the integration tests below, while still letting us (a) capture the
// request handler `startLocalApi` registers — so we can invoke it with synthetic
// req/res to reach defensive `??` / `headersSent` branches a real socket can never
// trigger — and (b) opt-in to a fully fake server whose `address()` is non-object,
// covering the `: port` fallback when address() does not return an AddressInfo.
let capturedHandler: ((req: unknown, res: unknown) => void) | undefined;
let fakeAddressServer: { address: () => unknown } | undefined;

vi.mock("node:http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:http")>();
  return {
    ...actual,
    createServer: (handler: (req: unknown, res: unknown) => void) => {
      capturedHandler = handler;
      if (fakeAddressServer) {
        const fake = fakeAddressServer;
        fakeAddressServer = undefined;
        return {
          once: () => {},
          listen: (_port: number, _host: string, cb: () => void) => {
            cb();
            return fake;
          },
          address: fake.address,
          close: (cb?: () => void) => cb?.(),
        } as unknown as Server;
      }
      return actual.createServer(handler);
    },
  };
});

// Import AFTER vi.mock so server.ts binds to the partially-mocked node:http.
const { parseBody, startLocalApi } = await import("../src/local/server.ts");
type LocalServerHandle = Awaited<ReturnType<typeof startLocalApi>>;

function makeCatalog(): LocalCatalogProblem[] {
  return [
    {
      problemId: "intro-flag",
      category: "Challenge",
      name: "Intro Flag",
      description: "Find the flag.",
      instructions: "Deploy and grab the flag.",
      scoringKind: "flag",
      points: 100,
      hints: [{ id: "h1", penalty: 10, content: "look harder" }],
      endpoints: [{ slot: "web", overridable: true, defaultKey: "url" }],
    },
  ];
}

// Tracks every started handle / raw server so afterEach can guarantee cleanup even
// when an assertion throws mid-test.
const openHandles: LocalServerHandle[] = [];
const openServers: Server[] = [];

async function start(
  catalog: LocalCatalogProblem[] = makeCatalog(),
  teamName?: string,
): Promise<LocalServerHandle> {
  const handle = await startLocalApi(0, catalog, teamName);
  openHandles.push(handle);
  return handle;
}

afterEach(async () => {
  while (openHandles.length > 0) {
    const handle = openHandles.pop();
    if (handle) await handle.close();
  }
  while (openServers.length > 0) {
    const server = openServers.pop();
    if (server) await new Promise<void>((done) => server.close(() => done()));
  }
});

describe("parseBody", () => {
  it("should return undefined for an empty string", () => {
    expect(parseBody("")).toBeUndefined();
  });

  it("should return undefined for a whitespace-only string", () => {
    expect(parseBody("   \n\t  ")).toBeUndefined();
  });

  it("should return the parsed value for valid JSON", () => {
    expect(parseBody('{"problemId":"intro-flag","flag":"x"}')).toEqual({
      problemId: "intro-flag",
      flag: "x",
    });
  });

  it("should return undefined for invalid JSON", () => {
    expect(parseBody("{not json")).toBeUndefined();
  });
});

describe("startLocalApi", () => {
  it("should expose the OS-assigned port and a usable state via the handle", async () => {
    const handle = await start(makeCatalog(), "My Squad");
    expect(handle.port).toBeGreaterThan(0);
    expect(handle.state.teamName).toBe("My Squad");
  });

  it("should answer GET /healthz with 200 and CORS headers", async () => {
    const handle = await start();
    const res = await fetch(`http://127.0.0.1:${handle.port}/healthz`);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-headers")).toBe("authorization, content-type");
    expect(res.headers.get("access-control-allow-methods")).toBe("GET, POST, PATCH, OPTIONS");
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ status: "ok", mode: "local" });
  });

  it("should answer an OPTIONS preflight with 204 and CORS headers", async () => {
    const handle = await start();
    const res = await fetch(`http://127.0.0.1:${handle.port}/portal/me`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toBe("GET, POST, PATCH, OPTIONS");
    expect(await res.text()).toBe("");
  });

  it("should answer GET /portal/me with the team view JSON", async () => {
    const handle = await start(makeCatalog(), "Team Alpha");
    const res = await fetch(`http://127.0.0.1:${handle.port}/portal/me`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      team: { teamName: string };
      problems: { problemId: string }[];
      eventGate: { kind: string };
    };
    expect(body.team.teamName).toBe("Team Alpha");
    expect(body.problems.map((p) => p.problemId)).toEqual(["intro-flag"]);
    expect(body.eventGate.kind).toBe("ok");
  });

  it("should parse a JSON POST body and route submit-flag (correct flag)", async () => {
    const handle = await start();
    const res = await fetch(`http://127.0.0.1:${handle.port}/portal/me/submit-flag`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ problemId: "intro-flag", flag: localPracticeFlag("intro-flag") }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kind: "ok", scoreDelta: 100, totalScore: 100 });
    expect(handle.state.solved.has("intro-flag")).toBe(true);
    expect(handle.state.score).toBe(100);
  });

  it("should treat an empty POST body as no JSON (parseBody undefined branch)", async () => {
    const handle = await start();
    // Empty body → parseBody("") === undefined → handleSubmit sees body ?? {} → unknown_problem.
    const res = await fetch(`http://127.0.0.1:${handle.port}/portal/me/submit-flag`, {
      method: "POST",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "unknown_problem" });
  });

  it("should treat an invalid JSON POST body as no JSON (parseBody catch branch)", async () => {
    const handle = await start();
    const res = await fetch(`http://127.0.0.1:${handle.port}/portal/me/submit-flag`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ this is not valid json",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "unknown_problem" });
  });

  it("should parse query params into the router request", async () => {
    const handle = await start();
    const res = await fetch(`http://127.0.0.1:${handle.port}/portal/me/deploy-logs?jobId=job-xyz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jobId: "job-xyz", complete: true, entries: [] });
  });

  it("should return 404 JSON for an unknown route", async () => {
    const handle = await start();
    const res = await fetch(`http://127.0.0.1:${handle.port}/nope`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("should return 500 {error:internal} when the body exceeds MAX_BODY_BYTES", async () => {
    const handle = await start();
    // >1MB body → readBody rejects ("payload too large") → onRequest rejects →
    // createServer's .catch writes 500 before headers are sent.
    const big = "a".repeat(1_000_001);
    const res = await fetch(`http://127.0.0.1:${handle.port}/portal/me/submit-flag`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: big,
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal" });
  });

  it("should reject the start promise when the port is already bound (EADDRINUSE)", async () => {
    // Bind a plain server first, grab its concrete port, then ask startLocalApi to
    // bind the same port → server.once("error", reject) fires with EADDRINUSE.
    const blocker = createServer(() => {});
    openServers.push(blocker);
    const blockerPort = await new Promise<number>((resolve) => {
      blocker.listen(0, "127.0.0.1", () => {
        resolve((blocker.address() as AddressInfo).port);
      });
    });

    await expect(startLocalApi(blockerPort, makeCatalog())).rejects.toMatchObject({
      code: "EADDRINUSE",
    });
  });

  it("should fall back to the requested port when address() is not an AddressInfo", async () => {
    // The Unix-domain-socket case: server.address() returns a string, so
    // `typeof addr === "object"` is false → boundPort falls back to the requested port.
    fakeAddressServer = { address: () => "/tmp/some.sock" };
    const handle = await startLocalApi(7777, makeCatalog());
    openHandles.push(handle);
    expect(handle.port).toBe(7777);
  });
});

/**
 * Defensive branches a real socket cannot reach: Node's HTTP parser always sets
 * `req.method` and `req.url` to strings (asterisk-form yields "*", never undefined),
 * and in the natural flow the error catch only fires from `readBody` rejecting —
 * before any header is written, so `res.headersSent` is always false there. We drive
 * the captured request handler with synthetic req/res to cover the fallback paths.
 */
describe("startLocalApi request handler (synthetic req/res)", () => {
  // A minimal IncomingMessage-shaped EventEmitter; tests fire data/end/error on it.
  function fakeReq(method: string | undefined, url: string | undefined): EventEmitter {
    const req = new EventEmitter() as EventEmitter & { method?: string; url?: string };
    req.method = method;
    req.url = url;
    return req;
  }

  // A ServerResponse stand-in that resolves `done` once `end()` is called.
  function fakeRes() {
    let resolveDone: () => void = () => {};
    const done = new Promise<void>((r) => {
      resolveDone = r;
    });
    const calls: { writeHead?: [number, unknown?]; ended: boolean; body?: string } = {
      ended: false,
    };
    const res = {
      headersSent: false,
      setHeader: () => {},
      writeHead(status: number, headers?: unknown) {
        calls.writeHead = [status, headers];
        res.headersSent = true;
        return res;
      },
      end(body?: string) {
        calls.ended = true;
        calls.body = body;
        resolveDone();
        return res;
      },
    };
    return { res, calls, done };
  }

  it("should default method to GET and url to / when both are undefined", async () => {
    await start();
    const handler = capturedHandler;
    if (!handler) throw new Error("request handler was not captured");
    const req = fakeReq(undefined, undefined);
    const { res, calls, done } = fakeRes();
    handler(req, res);
    req.emit("end"); // empty body
    await done;
    // method ?? "GET" + url ?? "/" → GET / → not a known route → 404 not_found.
    expect(calls.writeHead?.[0]).toBe(404);
    expect(calls.body).toBe(JSON.stringify({ error: "not_found" }));
  });

  it("should write a bare 500 body when the catch fires after headers are already sent", async () => {
    await start();
    const handler = capturedHandler;
    if (!handler) throw new Error("request handler was not captured");
    const req = fakeReq("POST", "/portal/me/submit-flag");
    const { res, calls, done } = fakeRes();
    res.headersSent = true; // simulate headers already flushed before the failure
    handler(req, res);
    req.emit("error", new Error("boom")); // readBody rejects → onRequest rejects → catch
    await done;
    // headersSent === true → the `if (!res.headersSent) writeHead(500)` is skipped.
    expect(calls.writeHead).toBeUndefined();
    expect(calls.body).toBe(JSON.stringify({ error: "internal" }));
  });
});
