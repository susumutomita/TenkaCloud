import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveTokens } from "../src/credential-store.ts";
import { type ApiError, fetchWithAuth } from "../src/http/fetch-with-auth.ts";

let originalHome: string | undefined;
let tempDir: string;

beforeEach(() => {
  originalHome = process.env.HOME;
  tempDir = mkdtempSync(join(tmpdir(), "cli-fetch-"));
  process.env.HOME = tempDir;
  saveTokens({
    accessToken: "test-bearer",
    idToken: "test-id",
    refreshToken: "test-rt",
    expiresAt: Math.floor(Date.now() / 1000) + 10000,
    issuer: "https://cognito-idp.local/userpool",
    clientId: "client-1",
  });
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("fetchWithAuth", () => {
  it("should attach Authorization header and call the correct URL", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const result = await fetchWithAuth(
      "https://api.example.com",
      "/tenants",
      { query: { foo: "bar" } },
      {
        hostedUiDomain: "https://auth.example.com",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );
    expect(result).toEqual({ ok: true });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://api.example.com/tenants?foo=bar");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer test-bearer");
  });

  it("should map 401 to user-friendly ApiError", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 401 }));
    await expect(
      fetchWithAuth(
        "https://api.example.com",
        "/x",
        {},
        {
          hostedUiDomain: "https://auth.example.com",
          fetchImpl: fetchImpl as unknown as typeof fetch,
        },
      ),
    ).rejects.toMatchObject({
      status: 401,
      userMessage: expect.stringContaining("tenkacloud login"),
    });
  });

  it("should map 403 to permission error", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 403 }));
    await expect(
      fetchWithAuth(
        "https://api.example.com",
        "/x",
        {},
        {
          hostedUiDomain: "https://auth.example.com",
          fetchImpl: fetchImpl as unknown as typeof fetch,
        },
      ),
    ).rejects.toMatchObject({ status: 403, userMessage: expect.stringContaining("権限") });
  });

  it("should map 404 to not-found", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 404 }));
    await expect(
      fetchWithAuth(
        "https://api.example.com",
        "/x",
        {},
        {
          hostedUiDomain: "https://auth.example.com",
          fetchImpl: fetchImpl as unknown as typeof fetch,
        },
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("should map 5xx to retry suggestion", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 503 }));
    await expect(
      fetchWithAuth(
        "https://api.example.com",
        "/x",
        {},
        {
          hostedUiDomain: "https://auth.example.com",
          fetchImpl: fetchImpl as unknown as typeof fetch,
        },
      ),
    ).rejects.toMatchObject({ status: 503, userMessage: expect.stringContaining("再試行") });
  });

  it("should map other 4xx (e.g. 400) to a generic API error message", async () => {
    const fetchImpl = vi.fn(async () => new Response('{"error":"bad request"}', { status: 400 }));
    await expect(
      fetchWithAuth(
        "https://api.example.com",
        "/widgets",
        {},
        {
          hostedUiDomain: "https://auth.example.com",
          fetchImpl: fetchImpl as unknown as typeof fetch,
        },
      ),
    ).rejects.toMatchObject({
      status: 400,
      userMessage: "API error (HTTP 400): /widgets",
      body: { error: "bad request" },
    });
  });

  it("should return the raw text when the body is not valid JSON", async () => {
    const fetchImpl = vi.fn(async () => new Response("plain-text-not-json", { status: 200 }));
    const result = await fetchWithAuth(
      "https://api.example.com",
      "/health",
      {},
      {
        hostedUiDomain: "https://auth.example.com",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );
    expect(result).toBe("plain-text-not-json");
  });

  it("should return undefined when a 200 body is empty", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 200 }));
    const result = await fetchWithAuth(
      "https://api.example.com",
      "/x",
      {},
      {
        hostedUiDomain: "https://auth.example.com",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );
    expect(result).toBeUndefined();
  });

  it("should prepend a leading slash to a relative path", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    await fetchWithAuth(
      "https://api.example.com",
      "tenants", // no leading slash
      {},
      {
        hostedUiDomain: "https://auth.example.com",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("https://api.example.com/tenants");
  });

  it("should skip undefined query parameters", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    await fetchWithAuth(
      "https://api.example.com",
      "/tenants",
      { query: { keep: "yes", drop: undefined, num: 5 } },
      {
        hostedUiDomain: "https://auth.example.com",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );
    const url = String(fetchImpl.mock.calls[0]?.[0]);
    expect(url).toContain("keep=yes");
    expect(url).toContain("num=5");
    expect(url).not.toContain("drop");
  });

  it("should set the ApiError body to undefined when the error body is not JSON", async () => {
    // res.json() rejects on a non-JSON error body, exercising the .catch fallback.
    const fetchImpl = vi.fn(async () => new Response("not-json-error-body", { status: 500 }));
    let captured: ApiError | undefined;
    try {
      await fetchWithAuth(
        "https://api.example.com",
        "/x",
        {},
        {
          hostedUiDomain: "https://auth.example.com",
          fetchImpl: fetchImpl as unknown as typeof fetch,
        },
      );
    } catch (err) {
      captured = err as ApiError;
    }
    expect(captured?.status).toBe(500);
    expect(captured?.body).toBeUndefined();
  });

  it("should serialize JSON body with content-type", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
    await fetchWithAuth(
      "https://api.example.com",
      "/tenants",
      { method: "POST", body: { name: "x" } },
      {
        hostedUiDomain: "https://auth.example.com",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(init.body).toBe('{"name":"x"}');
  });

  it("should return undefined on 204", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const result = await fetchWithAuth(
      "https://api.example.com",
      "/x",
      { method: "DELETE" },
      {
        hostedUiDomain: "https://auth.example.com",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );
    expect(result).toBeUndefined();
  });

  it("should never leak the bearer token into ApiError body", async () => {
    const fetchImpl = vi.fn(async () => new Response('{"error":"forbidden"}', { status: 403 }));
    try {
      await fetchWithAuth(
        "https://api.example.com",
        "/x",
        {},
        {
          hostedUiDomain: "https://auth.example.com",
          fetchImpl: fetchImpl as unknown as typeof fetch,
        },
      );
    } catch (err) {
      const e = err as ApiError;
      expect(JSON.stringify(e.body)).not.toContain("test-bearer");
      expect(e.userMessage).not.toContain("test-bearer");
    }
  });
});

describe("fetchWithAuth (no credentials)", () => {
  it("should throw 401 ApiError when credential store empty", async () => {
    rmSync(join(tempDir, ".config/tenkacloud/credentials"), { force: true });
    await expect(
      fetchWithAuth(
        "https://api.example.com",
        "/x",
        {},
        { hostedUiDomain: "https://auth.example.com" },
      ),
    ).rejects.toMatchObject({ status: 401 });
  });
});

describe("fetchWithAuth (token refresh paths)", () => {
  it("should map a RefreshError from token refresh to a 401 ApiError", async () => {
    // stored token is already expired → getValidTokens attempts a refresh,
    // and the refresh endpoint rejects it → RefreshError → mapped to 401.
    const now = 10_000;
    saveTokens({
      accessToken: "stale",
      idToken: "stale-id",
      refreshToken: "stale-rt",
      expiresAt: now - 100,
      issuer: "https://cognito-idp.local/userpool",
      clientId: "client-1",
    });
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 401 }));
    let captured: ApiError | undefined;
    try {
      await fetchWithAuth(
        "https://api.example.com",
        "/x",
        {},
        {
          hostedUiDomain: "https://auth.example.com",
          fetchImpl: fetchImpl as unknown as typeof fetch,
          nowSec: () => now,
        },
      );
    } catch (err) {
      captured = err as ApiError;
    }
    expect(captured?.status).toBe(401);
    expect(captured?.userMessage).toContain("tenkacloud login");
    // The cause must carry the refresh failure message, not the token itself.
    expect(JSON.stringify(captured?.body)).not.toContain("stale-rt");
  });

  it("should re-throw a non-RefreshError raised while persisting refreshed tokens", async () => {
    // After a successful refresh, getValidTokens calls saveTokens(). If that write
    // fails (e.g. the credentials directory is read-only), a plain filesystem Error
    // — not a RefreshError — escapes getValidTokens and must propagate verbatim.
    const now = 10_000;
    saveTokens({
      accessToken: "stale",
      idToken: "stale-id",
      refreshToken: "stale-rt",
      expiresAt: now - 100,
      issuer: "https://cognito-idp.local/userpool",
      clientId: "client-1",
    });
    // Make the credentials file itself read-only so the post-refresh write throws.
    const credPath = join(tempDir, ".config/tenkacloud/credentials");
    const credDir = dirname(credPath);
    chmodSync(credPath, 0o400);
    chmodSync(credDir, 0o500);
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            access_token: "fresh",
            id_token: "fresh-id",
            refresh_token: "fresh-rt",
            expires_in: 3600,
          }),
          { status: 200 },
        ),
    );
    let captured: unknown;
    try {
      await fetchWithAuth(
        "https://api.example.com",
        "/x",
        {},
        {
          hostedUiDomain: "https://auth.example.com",
          fetchImpl: fetchImpl as unknown as typeof fetch,
          nowSec: () => now,
        },
      );
    } catch (err) {
      captured = err;
    } finally {
      // Restore perms so afterEach cleanup can remove the temp dir.
      chmodSync(credDir, 0o700);
      chmodSync(credPath, 0o600);
    }
    // It must NOT have been remapped to an ApiError(401); the raw error propagates.
    expect(captured).toBeInstanceOf(Error);
    expect((captured as { name?: string }).name).not.toBe("ApiError");
  });
});
