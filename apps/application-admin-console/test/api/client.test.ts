import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, createApiClient } from "../../src/api/client";
import type { AppConfig } from "../../src/config";

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
});
