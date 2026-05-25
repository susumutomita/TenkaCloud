import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
