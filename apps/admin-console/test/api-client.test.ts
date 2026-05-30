import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, createApiClient, useApiClient } from "../src/api/client";
import type { AppConfig } from "../src/config";

const { mockUseAuth } = vi.hoisted(() => ({ mockUseAuth: vi.fn() }));
vi.mock("../src/auth/AuthProvider", () => ({ useAuth: mockUseAuth }));

const config: AppConfig = {
  cognitoDomain: "https://example.com",
  cognitoClientId: "id",
  redirectUri: "http://localhost/callback",
  apiBaseUrl: "https://api.example.com/prod",
  scope: "openid",
  pooledApplicationAdminConsoleUrl: "",
  provisioningCodeBuildProject: "unknown",
  awsRegion: "",
  awsAccountId: "",
  adminInsightApiUrl: "",
  cloudWatchDashboardName: "",
  samlIdpDirectory: {},
};

describe("createApiClient", () => {
  afterEach(() => vi.restoreAllMocks());

  describe("when calling GET", () => {
    it("should append the path to apiBaseUrl and attach an Authorization header", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      const api = createApiClient(config, "TOKEN");
      await api.get("tenants");

      const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
      expect(url.toString()).toBe("https://api.example.com/prod/tenants");
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer TOKEN");
    });
  });

  describe("when calling POST", () => {
    it("should send the body as a JSON string", async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      const api = createApiClient(config, "T");
      await api.post("tenants", { tenantName: "A" });

      const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
      expect(init.method).toBe("POST");
      expect(init.body).toBe(JSON.stringify({ tenantName: "A" }));
    });
  });

  describe("when the server returns 4xx", () => {
    it("should throw an ApiError", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response("bad", { status: 400, statusText: "Bad" })),
      );

      const api = createApiClient(config, "T");
      await expect(api.get("tenants")).rejects.toBeInstanceOf(ApiError);
    });

    it("should fall back to statusText when the error body cannot be read", async () => {
      // res.text() が reject → `.catch(() => "")` で空文字 → statusText を message に使う。
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 503,
          statusText: "Service Unavailable",
          text: () => Promise.reject(new Error("stream error")),
        } as unknown as Response),
      );
      const api = createApiClient(config, "T");
      await expect(api.get("tenants")).rejects.toMatchObject({
        status: 503,
        message: expect.stringContaining("Service Unavailable"),
      });
    });
  });

  it("should append a trailing slash to apiBaseUrl when it lacks one (already-slash kept)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const api = createApiClient({ ...config, apiBaseUrl: "https://api.example.com/prod/" }, "T");
    await api.get("tenants");
    const [url] = fetchMock.mock.calls[0] as [URL];
    expect(url.toString()).toBe("https://api.example.com/prod/tenants");
  });

  it("should issue a DELETE for del() and resolve void", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const api = createApiClient(config, "T");
    await expect(api.del("tenants/t-1")).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://api.example.com/prod/tenants/t-1");
    expect(init.method).toBe("DELETE");
  });
});

describe("useApiClient", () => {
  afterEach(() => vi.restoreAllMocks());

  it("should return a client when auth tokens are present", () => {
    mockUseAuth.mockReturnValue({ tokens: { idToken: "tok" } });
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
