import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, createApiClient } from "../src/api/client";
import type { AppConfig } from "../src/config";

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
  });
});
