import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, createApiClient, useApiClient } from "../../src/api/client";
import type { AppConfig } from "../../src/config";

const { mockUseAuth } = vi.hoisted(() => ({ mockUseAuth: vi.fn() }));
vi.mock("../../src/auth/AuthProvider", () => ({ useAuth: mockUseAuth }));

const config: AppConfig = {
  cognitoDomain: "https://example.com",
  cognitoClientId: "id",
  redirectUri: "http://localhost/callback",
  scope: "openid",
  tenantId: "t-1",
  tenantName: "T1",
  apiBaseUrl: "https://api.example.com/prod",
  samlIdpDirectory: {},
};

function b64url(value: object): string {
  const json = JSON.stringify(value);
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function makeJwt(payload: object): string {
  return `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url(payload)}.signature`;
}

describe("createApiClient", () => {
  afterEach(() => vi.restoreAllMocks());

  describe("when calling GET", () => {
    it("should concatenate path to apiBaseUrl and attach Authorization header", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ apps: [] }), { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      const api = createApiClient(config.apiBaseUrl, "TOKEN");
      await api.get("apps");

      const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
      expect(url.toString()).toBe("https://api.example.com/prod/apps");
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer TOKEN");
    });
  });

  describe("tenant access metadata", () => {
    it("should expose canMutateTenant=false for TenantViewer tokens", () => {
      const token = makeJwt({ "custom:userRole": "TenantViewer" });
      const api = createApiClient(config.apiBaseUrl, token);
      expect(api.tenantAccess).toEqual({ role: "viewer", canMutateTenant: false });
    });
  });

  describe("when calling POST", () => {
    it("should set content-type: application/json and JSON.stringify the body", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 201 }));
      vi.stubGlobal("fetch", fetchMock);

      const api = createApiClient(config.apiBaseUrl, "TOKEN");
      await api.post("apps", { name: "x", upstreamUrl: "https://x.example.com" });

      const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
      expect(init.method).toBe("POST");
      expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
      expect(init.body).toBe('{"name":"x","upstreamUrl":"https://x.example.com"}');
    });
  });

  describe("when API returns 4xx/5xx", () => {
    it("should throw an ApiError (including status and body)", async () => {
      // Response body は 1 度しか read できないので毎回 fresh な Response を返す
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockImplementation(() => Promise.resolve(new Response("forbidden", { status: 403 }))),
      );
      const api = createApiClient(config.apiBaseUrl, "TOKEN");

      await expect(api.get("apps")).rejects.toBeInstanceOf(ApiError);
      // Issue #873: regex regression を回避。
      await expect(api.get("apps")).rejects.toMatchObject({
        message: expect.stringMatching(/403.*forbidden/),
      });
    });
  });

  describe("trailing slash on apiBaseUrl", () => {
    it("should build the same URL regardless of trailing slash presence", async () => {
      const fetchMock = vi
        .fn()
        .mockImplementation(() => Promise.resolve(new Response("{}", { status: 200 })));
      vi.stubGlobal("fetch", fetchMock);

      const a = createApiClient("https://api.example.com/prod", "T");
      const b = createApiClient("https://api.example.com/prod/", "T");
      await a.get("apps");
      await b.get("apps");

      const url1 = (fetchMock.mock.calls[0] as [URL, RequestInit])[0].toString();
      const url2 = (fetchMock.mock.calls[1] as [URL, RequestInit])[0].toString();
      expect(url1).toBe(url2);
    });
  });

  describe("PUT / PATCH / DELETE verbs", () => {
    it("should send PUT with a JSON body and return the parsed response", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ registered: true }), { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      const res = await createApiClient(config.apiBaseUrl, "T").put<{ registered: boolean }>(
        "admin/team-cloud-credentials/sakura/team-a",
        { accessToken: "x" },
      );
      const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
      expect(init.method).toBe("PUT");
      expect(init.body).toBe('{"accessToken":"x"}');
      expect(res).toEqual({ registered: true });
    });

    it("should send PATCH with a JSON body", async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      await createApiClient(config.apiBaseUrl, "T").patch("apps/1", { name: "y" });
      const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
      expect(init.method).toBe("PATCH");
      expect(init.body).toBe('{"name":"y"}');
    });

    it("should send DELETE returning void (del) and JSON (delJson)", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ removed: 3 }), { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      const api = createApiClient(config.apiBaseUrl, "T");
      await expect(api.del("apps/1")).resolves.toBeUndefined();
      await expect(api.delJson<{ removed: number }>("apps/1")).resolves.toEqual({ removed: 3 });
      expect((fetchMock.mock.calls[0] as [URL, RequestInit])[1].method).toBe("DELETE");
    });
  });

  describe("network failure", () => {
    it("should normalize a thrown fetch (TypeError) into an ApiError with status 0", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
      const api = createApiClient(config.apiBaseUrl, "T");
      await expect(api.post("apps", {})).rejects.toMatchObject({
        status: 0,
        message: expect.stringMatching(/Network error: Failed to fetch.*method: POST/),
      });
      // GET は init.method 未指定 → メッセージは "GET" に fallback (?? 分岐)。
      await expect(api.get("apps")).rejects.toMatchObject({
        status: 0,
        message: expect.stringMatching(/method: GET/),
      });
    });
  });

  describe("error body fallback", () => {
    it("should fall back to statusText when the error body is empty", async () => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockImplementation(() =>
            Promise.resolve(new Response("", { status: 502, statusText: "Bad Gateway" })),
          ),
      );
      const api = createApiClient(config.apiBaseUrl, "T");
      await expect(api.get("apps")).rejects.toMatchObject({
        message: expect.stringMatching(/502.*Bad Gateway/),
      });
    });

    it("should fall back to statusText when reading the error body throws", async () => {
      // res.text() が reject するケース → `.catch(() => "")` 経由で空文字 → statusText。
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
          statusText: "Server Error",
          text: () => Promise.reject(new Error("stream broken")),
        }),
      );
      const api = createApiClient(config.apiBaseUrl, "T");
      await expect(api.get("apps")).rejects.toMatchObject({
        message: expect.stringMatching(/500.*Server Error/),
      });
    });
  });
});

describe("useApiClient", () => {
  afterEach(() => vi.clearAllMocks());

  it("should return a client when auth tokens are present", () => {
    mockUseAuth.mockReturnValue({ tokens: { idToken: "TOKEN" } });
    const { result } = renderHook(() => useApiClient(config));
    expect(result.current).not.toBeNull();
    expect(typeof result.current?.get).toBe("function");
  });

  it("should return null when there are no auth tokens", () => {
    mockUseAuth.mockReturnValue({ tokens: null });
    const { result } = renderHook(() => useApiClient(config));
    expect(result.current).toBeNull();
  });
});
