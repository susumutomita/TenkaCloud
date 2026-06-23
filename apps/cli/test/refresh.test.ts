import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getValidTokens, needsRefresh, RefreshError, refreshTokens } from "../src/auth/refresh.ts";
import { clearTokens, loadTokens, type StoredTokens, saveTokens } from "../src/credential-store.ts";

function makeTokens(overrides: Partial<StoredTokens> = {}): StoredTokens {
  return {
    accessToken: "old-access",
    idToken: "old-id",
    refreshToken: "old-refresh",
    expiresAt: 0,
    issuer: "https://cognito-idp.local/userpool",
    clientId: "client-123",
    ...overrides,
  };
}

let originalHome: string | undefined;
let tempDir: string;

beforeEach(() => {
  originalHome = process.env.HOME;
  tempDir = mkdtempSync(join(tmpdir(), "cli-refresh-"));
  process.env.HOME = tempDir;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("needsRefresh", () => {
  it("should return true when token expires within threshold", () => {
    const now = 1000;
    const tokens = makeTokens({ expiresAt: 1100 });
    expect(needsRefresh(tokens, 300, now)).toBe(true);
  });
  it("should return false when token has plenty of time", () => {
    const now = 1000;
    const tokens = makeTokens({ expiresAt: 5000 });
    expect(needsRefresh(tokens, 300, now)).toBe(false);
  });
});

describe("refreshTokens", () => {
  it("should POST to /oauth2/token with refresh_token grant", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            access_token: "new-access",
            id_token: "new-id",
            refresh_token: "new-refresh",
            expires_in: 3600,
          }),
          { status: 200 },
        ),
    );
    const tokens = makeTokens();
    const refreshed = await refreshTokens(tokens, {
      hostedUiDomain: "https://auth.example.com",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      nowSec: () => 1000,
    });
    expect(refreshed.accessToken).toBe("new-access");
    expect(refreshed.expiresAt).toBe(1000 + 3600);
    expect(refreshed.refreshToken).toBe("new-refresh");
    const callArgs = fetchImpl.mock.calls[0];
    expect(callArgs?.[0]).toBe("https://auth.example.com/oauth2/token");
    const opts = callArgs?.[1] as RequestInit;
    expect((opts.body as string).includes("grant_type=refresh_token")).toBe(true);
    expect((opts.body as string).includes("client_id=client-123")).toBe(true);
  });

  it("should throw RefreshError on HTTP failure", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 400 }));
    await expect(
      refreshTokens(makeTokens(), {
        hostedUiDomain: "https://auth.example.com",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(RefreshError);
  });

  it("should throw RefreshError without calling fetch when refresh_token is empty", async () => {
    const fetchImpl = vi.fn();
    await expect(
      refreshTokens(makeTokens({ refreshToken: "" }), {
        hostedUiDomain: "https://auth.example.com",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({
      name: "RefreshError",
      message: expect.stringContaining("refresh_token"),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("should wrap a network error into a RefreshError carrying the cause", async () => {
    const netErr = new Error("ECONNREFUSED");
    const fetchImpl = vi.fn(async () => {
      throw netErr;
    });
    let captured: RefreshError | undefined;
    try {
      await refreshTokens(makeTokens(), {
        hostedUiDomain: "https://auth.example.com",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
    } catch (err) {
      captured = err as RefreshError;
    }
    expect(captured).toBeInstanceOf(RefreshError);
    expect(captured?.message).toContain("network error");
    expect(captured?.cause).toBe(netErr);
  });

  it("should throw RefreshError when the response omits required fields", async () => {
    // ok response but missing access_token / id_token / expires_in.
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ token_type: "Bearer" }), { status: 200 }),
    );
    await expect(
      refreshTokens(makeTokens(), {
        hostedUiDomain: "https://auth.example.com",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({
      name: "RefreshError",
      message: expect.stringContaining("不正"),
    });
  });

  it("should throw RefreshError when the response body is not JSON", async () => {
    // res.json() rejects → caught into {} → missing-field guard throws.
    const fetchImpl = vi.fn(async () => new Response("not-json", { status: 200 }));
    await expect(
      refreshTokens(makeTokens(), {
        hostedUiDomain: "https://auth.example.com",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(RefreshError);
  });

  it("should fall back to the global fetch when fetchImpl is not provided", async () => {
    const globalFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            access_token: "g-access",
            id_token: "g-id",
            refresh_token: "g-rt",
            expires_in: 3600,
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", globalFetch);
    try {
      const refreshed = await refreshTokens(makeTokens(), {
        hostedUiDomain: "https://auth.example.com",
        nowSec: () => 500,
      });
      expect(refreshed.accessToken).toBe("g-access");
      expect(refreshed.expiresAt).toBe(500 + 3600);
      expect(globalFetch).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("should compute expiresAt from wall-clock now when nowSec is not provided", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            access_token: "a",
            id_token: "b",
            expires_in: 100,
          }),
          { status: 200 },
        ),
    );
    const before = Math.floor(Date.now() / 1000);
    const refreshed = await refreshTokens(makeTokens(), {
      hostedUiDomain: "https://auth.example.com",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const after = Math.floor(Date.now() / 1000);
    expect(refreshed.expiresAt).toBeGreaterThanOrEqual(before + 100);
    expect(refreshed.expiresAt).toBeLessThanOrEqual(after + 100);
  });

  it("should keep prior refresh_token if response omits it (Cognito non-rotation)", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            access_token: "a",
            id_token: "b",
            expires_in: 100,
          }),
          { status: 200 },
        ),
    );
    const refreshed = await refreshTokens(makeTokens({ refreshToken: "keep-me" }), {
      hostedUiDomain: "https://auth.example.com",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      nowSec: () => 0,
    });
    expect(refreshed.refreshToken).toBe("keep-me");
  });
});

describe("getValidTokens", () => {
  it("should return undefined when no tokens stored", async () => {
    clearTokens();
    const result = await getValidTokens({ hostedUiDomain: "https://auth.example.com" });
    expect(result).toBeUndefined();
  });

  it("should return stored tokens when expiry is far away", async () => {
    saveTokens(makeTokens({ expiresAt: Math.floor(Date.now() / 1000) + 10000 }));
    const fetchImpl = vi.fn();
    const tokens = await getValidTokens({
      hostedUiDomain: "https://auth.example.com",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(tokens?.accessToken).toBe("old-access");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("should refresh and persist when within 5 min of expiry", async () => {
    const now = 10_000;
    saveTokens(makeTokens({ expiresAt: now + 60 })); // 1 min remaining
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            access_token: "fresh-access",
            id_token: "fresh-id",
            refresh_token: "fresh-rt",
            expires_in: 3600,
          }),
          { status: 200 },
        ),
    );
    const tokens = await getValidTokens({
      hostedUiDomain: "https://auth.example.com",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      nowSec: () => now,
    });
    expect(tokens?.accessToken).toBe("fresh-access");
    expect(loadTokens()?.accessToken).toBe("fresh-access");
  });

  it("should throw RefreshError when refresh fails", async () => {
    const now = 10_000;
    saveTokens(makeTokens({ expiresAt: now - 100 })); // already expired
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 401 }));
    await expect(
      getValidTokens({
        hostedUiDomain: "https://auth.example.com",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        nowSec: () => now,
      }),
    ).rejects.toBeInstanceOf(RefreshError);
  });
});
