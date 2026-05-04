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
};

describe("createApiClient", () => {
  afterEach(() => vi.restoreAllMocks());

  describe("GET 呼び出し時", () => {
    it("apiBaseUrl にパスを連結し Authorization ヘッダを付与すべき", async () => {
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

  describe("POST 呼び出し時", () => {
    it("body を JSON 文字列にして送るべき", async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      const api = createApiClient(config, "T");
      await api.post("tenants", { tenantName: "A" });

      const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
      expect(init.method).toBe("POST");
      expect(init.body).toBe(JSON.stringify({ tenantName: "A" }));
    });
  });

  describe("サーバが 4xx を返したとき", () => {
    it("ApiError を投げるべき", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response("bad", { status: 400, statusText: "Bad" })),
      );

      const api = createApiClient(config, "T");
      await expect(api.get("tenants")).rejects.toBeInstanceOf(ApiError);
    });
  });
});
