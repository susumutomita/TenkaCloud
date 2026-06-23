import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

/**
 * src/oauth.ts unit tests (Issue #988 — Authorization Code + PKCE + loopback flow).
 *
 * oauth.ts uses `node:http` createServer and the global `fetch` directly, so we
 * mock `node:http` to capture the request handler (and drive fake req/res through
 * every branch) and stub global `fetch` to drive the token-exchange branches.
 *
 * The captured `createServer` handler lets us simulate the Cognito redirect:
 *   - success  (?code=... → HTML written, waitForCode resolves)
 *   - error    (?error=... → 400, waitForCode rejects)
 *   - no code  (?nothing → 400 "Missing code", waitForCode never resolves)
 */

// ---- node:http mock --------------------------------------------------------
// Captures the request handler passed to createServer and exposes hooks so each
// test can simulate listen/error and invoke the handler with fake req/res.

type RequestHandler = (req: { url?: string }, res: FakeResponse) => void;

interface FakeResponse {
  writeHead: Mock;
  end: Mock;
}

interface FakeServer {
  on: Mock;
  listen: Mock;
  address: Mock;
  close: Mock;
}

interface ServerHarness {
  handler: RequestHandler;
  server: FakeServer;
  errorHandlers: Array<(err: Error) => void>;
  /** call to fire the "listening" callback so startLoopbackServer resolves */
  triggerListen: () => void;
}

let currentHarness: ServerHarness | undefined;
const createServerMock = vi.fn((handler: RequestHandler): FakeServer => {
  const errorHandlers: Array<(err: Error) => void> = [];
  let listenCallback: (() => void) | undefined;

  const server: FakeServer = {
    on: vi.fn((event: string, cb: (err: Error) => void) => {
      if (event === "error") errorHandlers.push(cb);
      return server;
    }),
    listen: vi.fn((_port: number, _host: string, cb: () => void) => {
      listenCallback = cb;
      return server;
    }),
    address: vi.fn(() => ({ port: 54321, family: "IPv4", address: "127.0.0.1" })),
    close: vi.fn(),
  };

  currentHarness = {
    handler,
    server,
    errorHandlers,
    triggerListen: () => listenCallback?.(),
  };
  return server;
});

vi.mock("node:http", () => ({
  createServer: (handler: RequestHandler) => createServerMock(handler),
}));

// Import AFTER vi.mock so oauth.ts picks up the mocked node:http.
const { signInWithCognito } = await import("../src/oauth.ts");

function makeFakeRes(): FakeResponse {
  return { writeHead: vi.fn(), end: vi.fn() };
}

function harness(): ServerHarness {
  if (!currentHarness) throw new Error("createServer was not called");
  return currentHarness;
}

const CONFIG = {
  hostedUiDomain: "https://prefix.auth.us-east-1.amazoncognito.com",
  clientId: "client-abc",
  issuer: "https://cognito-idp.us-east-1.amazonaws.com/pool",
};

const TOKEN_BODY = {
  access_token: "at-1",
  id_token: "id-1",
  refresh_token: "rt-1",
  expires_in: 3600,
};

let originalFetch: typeof fetch;

beforeEach(() => {
  createServerMock.mockClear();
  currentHarness = undefined;
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("signInWithCognito — happy path", () => {
  it("should open the browser with a PKCE authorize URL and return exchanged tokens", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(TOKEN_BODY), { status: 200 }));
    globalThis.fetch = fetchImpl as unknown as typeof fetch;

    const openBrowser = vi.fn(async () => {});
    const notify = vi.fn();

    const now = 1_700_000_000_000; // ms
    vi.spyOn(Date, "now").mockReturnValue(now);

    const promise = signInWithCognito(CONFIG, { openBrowser, notify });

    // startLoopbackServer must resolve once listen fires.
    harness().triggerListen();

    // openBrowser is awaited inside; let microtasks flush so authUrl is built.
    await Promise.resolve();
    await Promise.resolve();

    expect(openBrowser).toHaveBeenCalledTimes(1);
    const authUrl = new URL(openBrowser.mock.calls[0]?.[0] as string);
    expect(authUrl.origin + authUrl.pathname).toBe(
      "https://prefix.auth.us-east-1.amazoncognito.com/oauth2/authorize",
    );
    expect(authUrl.searchParams.get("response_type")).toBe("code");
    expect(authUrl.searchParams.get("client_id")).toBe("client-abc");
    expect(authUrl.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:54321/callback");
    expect(authUrl.searchParams.get("scope")).toBe("openid profile email");
    expect(authUrl.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    const state = authUrl.searchParams.get("state");
    expect(state).toHaveLength(12);

    // notify announces the browser launch with the same URL.
    expect(notify).toHaveBeenCalledWith(`ブラウザを起動します: ${authUrl.toString()}`);

    // Simulate Cognito redirecting back to the loopback with an auth code.
    const res = makeFakeRes();
    harness().handler({ url: "/callback?code=AUTH_CODE_123" }, res);

    // The callback page should be a 200 text/html response.
    expect(res.writeHead).toHaveBeenCalledWith(200, {
      "content-type": "text/html; charset=utf-8",
    });
    expect(res.end.mock.calls[0]?.[0]).toContain("sign-in 完了");

    const tokens = await promise;
    expect(tokens).toEqual({
      accessToken: "at-1",
      idToken: "id-1",
      refreshToken: "rt-1",
      expiresAt: Math.floor(now / 1000) + 3600,
    });

    // Token endpoint was called correctly.
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("https://prefix.auth.us-east-1.amazoncognito.com/oauth2/token");
    const opts = init as RequestInit;
    expect(opts.method).toBe("POST");
    expect((opts.headers as Record<string, string>)["content-type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    const sent = new URLSearchParams(opts.body as string);
    expect(sent.get("grant_type")).toBe("authorization_code");
    expect(sent.get("client_id")).toBe("client-abc");
    expect(sent.get("code")).toBe("AUTH_CODE_123");
    expect(sent.get("redirect_uri")).toBe("http://127.0.0.1:54321/callback");
    expect(sent.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // Server is always closed in the finally block.
    expect(harness().server.close).toHaveBeenCalledTimes(1);
  });

  it("should use a custom scope when provided and strip a trailing slash from the domain", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(TOKEN_BODY), { status: 200 }));
    globalThis.fetch = fetchImpl as unknown as typeof fetch;

    const openBrowser = vi.fn(async () => {});
    const notify = vi.fn();

    const promise = signInWithCognito(
      {
        ...CONFIG,
        hostedUiDomain: "https://prefix.auth.us-east-1.amazoncognito.com/",
        scope: "openid",
      },
      { openBrowser, notify },
    );
    harness().triggerListen();
    await Promise.resolve();
    await Promise.resolve();

    const authUrl = new URL(openBrowser.mock.calls[0]?.[0] as string);
    // Trailing slash stripped: exactly one "/oauth2/authorize", not "//oauth2".
    expect(authUrl.pathname).toBe("/oauth2/authorize");
    expect(authUrl.searchParams.get("scope")).toBe("openid");

    harness().handler({ url: "/callback?code=c" }, makeFakeRes());
    await promise;

    // Token endpoint also has the slash stripped (no double slash).
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      "https://prefix.auth.us-east-1.amazoncognito.com/oauth2/token",
    );
  });

  it("should default req.url to '/' when the request has no url", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(TOKEN_BODY), { status: 200 }));
    globalThis.fetch = fetchImpl as unknown as typeof fetch;

    const promise = signInWithCognito(CONFIG, {
      openBrowser: vi.fn(async () => {}),
      notify: vi.fn(),
    });
    harness().triggerListen();
    await Promise.resolve();

    // req with no url → URL("/", ...) → no code → 400 "Missing code".
    const res = makeFakeRes();
    harness().handler({}, res);
    expect(res.writeHead).toHaveBeenCalledWith(400, {
      "content-type": "text/plain; charset=utf-8",
    });
    expect(res.end).toHaveBeenCalledWith("Missing 'code' query parameter.");

    // A following valid code still completes the flow (server kept listening).
    harness().handler({ url: "/callback?code=later" }, makeFakeRes());
    await expect(promise).resolves.toMatchObject({ accessToken: "at-1" });
  });
});

describe("signInWithCognito — callback error branches", () => {
  it("should reject with OAuth error and write a 400 when the callback carries ?error", async () => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    const promise = signInWithCognito(CONFIG, {
      openBrowser: vi.fn(async () => {}),
      notify: vi.fn(),
    });
    harness().triggerListen();
    await Promise.resolve();

    const res = makeFakeRes();
    harness().handler({ url: "/callback?error=access_denied" }, res);

    expect(res.writeHead).toHaveBeenCalledWith(400, {
      "content-type": "text/plain; charset=utf-8",
    });
    expect(res.end).toHaveBeenCalledWith("OAuth error: access_denied");

    await expect(promise).rejects.toThrow("OAuth error: access_denied");
    // fetch must not run when the callback failed.
    expect(globalThis.fetch).not.toHaveBeenCalled();
    // Server still closes on the rejection path (finally).
    expect(harness().server.close).toHaveBeenCalledTimes(1);
  });

  it("should respond 400 'Missing code' and keep waiting when neither code nor error is present", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(TOKEN_BODY), { status: 200 }));
    globalThis.fetch = fetchImpl as unknown as typeof fetch;

    const promise = signInWithCognito(CONFIG, {
      openBrowser: vi.fn(async () => {}),
      notify: vi.fn(),
    });
    harness().triggerListen();
    await Promise.resolve();

    const res = makeFakeRes();
    harness().handler({ url: "/callback?foo=bar" }, res);
    expect(res.writeHead).toHaveBeenCalledWith(400, {
      "content-type": "text/plain; charset=utf-8",
    });
    expect(res.end).toHaveBeenCalledWith("Missing 'code' query parameter.");
    // No token exchange yet — still waiting.
    expect(fetchImpl).not.toHaveBeenCalled();

    // Then a real code arrives and resolves the still-open promise.
    harness().handler({ url: "/callback?code=ok" }, makeFakeRes());
    await expect(promise).resolves.toMatchObject({ accessToken: "at-1" });
  });
});

describe("signInWithCognito — token exchange branches", () => {
  it("should throw with status + body text when the token endpoint returns non-OK", async () => {
    const fetchImpl = vi.fn(async () => new Response("invalid_grant detail", { status: 400 }));
    globalThis.fetch = fetchImpl as unknown as typeof fetch;

    const promise = signInWithCognito(CONFIG, {
      openBrowser: vi.fn(async () => {}),
      notify: vi.fn(),
    });
    harness().triggerListen();
    await Promise.resolve();

    harness().handler({ url: "/callback?code=bad" }, makeFakeRes());

    await expect(promise).rejects.toThrow("Token exchange failed: HTTP 400 invalid_grant detail");
    expect(harness().server.close).toHaveBeenCalledTimes(1);
  });

  it("should fall back to empty body text when reading the error body throws", async () => {
    // res.ok = false and res.text() rejects → the `.catch(() => "")` branch.
    const badResponse = {
      ok: false,
      status: 500,
      text: vi.fn(async () => {
        throw new Error("stream broke");
      }),
      json: vi.fn(),
    };
    const fetchImpl = vi.fn(async () => badResponse as unknown as Response);
    globalThis.fetch = fetchImpl as unknown as typeof fetch;

    const promise = signInWithCognito(CONFIG, {
      openBrowser: vi.fn(async () => {}),
      notify: vi.fn(),
    });
    harness().triggerListen();
    await Promise.resolve();

    harness().handler({ url: "/callback?code=x" }, makeFakeRes());

    // Body text falls back to "" → trailing space after status.
    await expect(promise).rejects.toThrow("Token exchange failed: HTTP 500 ");
  });
});

describe("startLoopbackServer error path", () => {
  it("should reject signInWithCognito when the loopback server emits an 'error'", async () => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    const promise = signInWithCognito(CONFIG, {
      openBrowser: vi.fn(async () => {}),
      notify: vi.fn(),
    });

    // Fire the registered "error" handler instead of "listening".
    const boom = new Error("EADDRINUSE");
    for (const cb of harness().errorHandlers) cb(boom);

    await expect(promise).rejects.toThrow("EADDRINUSE");
    // We never reached listen → openBrowser/notify never ran.
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
