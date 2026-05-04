import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config";

afterEach(() => vi.restoreAllMocks());

const env = {
  VITE_COGNITO_DOMAIN: "https://dev-cognito.example.com",
  VITE_COGNITO_CLIENT_ID: "dev-client-id",
};

describe("loadConfig", () => {
  describe("/runtime-config.json が必須フィールドを全部返したとき", () => {
    async function loadWithFullRuntime() {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation(() =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                cognitoDomain: "https://prod-cognito.example.com",
                userClientId: "prod-client-id",
                tenantId: "tenant-prod-1",
                tenantName: "DENSO 第一事業部",
                apiUrl: "https://prod-api.example.com/prod",
                deployApiUrl: "https://prod-deploy.example.com",
              }),
              { status: 200 },
            ),
          ),
        ),
      );
      return loadConfig(env);
    }

    it("cognitoDomain を runtime-config から取るべき", async () => {
      expect((await loadWithFullRuntime()).cognitoDomain).toBe("https://prod-cognito.example.com");
    });

    it("cognitoClientId を runtime-config.userClientId から取るべき (key が異なる)", async () => {
      expect((await loadWithFullRuntime()).cognitoClientId).toBe("prod-client-id");
    });

    it("tenantId を runtime-config から取るべき", async () => {
      expect((await loadWithFullRuntime()).tenantId).toBe("tenant-prod-1");
    });

    it("tenantName を runtime-config から取るべき", async () => {
      expect((await loadWithFullRuntime()).tenantName).toBe("DENSO 第一事業部");
    });

    it("apiBaseUrl を runtime-config.apiUrl から取るべき (key が異なる)", async () => {
      expect((await loadWithFullRuntime()).apiBaseUrl).toBe("https://prod-api.example.com/prod");
    });

    it("deployApiBaseUrl を runtime-config.deployApiUrl から取るべき", async () => {
      expect((await loadWithFullRuntime()).deployApiBaseUrl).toBe(
        "https://prod-deploy.example.com",
      );
    });
  });

  describe("/runtime-config.json が 404 を返したとき (dev fallback)", () => {
    it("VITE_COGNITO_* env と DEV_FALLBACK_* placeholder から AppConfig を組み立てるべき", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));

      const config = await loadConfig(env);
      expect(config.cognitoDomain).toBe("https://dev-cognito.example.com");
      expect(config.cognitoClientId).toBe("dev-client-id");
      expect(config.tenantId).toBe("dev-local");
      expect(config.tenantName).toBe("Local Dev Tenant");
      expect(config.apiBaseUrl).toBe("http://localhost:3999");
      expect(config.deployApiBaseUrl).toBe("http://localhost:3998");
    });
  });

  describe("/runtime-config.json が 200 だがいずれかのフィールドを欠いているとき", () => {
    it("cognitoDomain 欠け → env fallback に進むべき", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              userClientId: "x",
              tenantId: "t",
              tenantName: "n",
              apiUrl: "https://a",
            }),
            {
              status: 200,
            },
          ),
        ),
      );

      const config = await loadConfig(env);
      expect(config.cognitoDomain).toBe("https://dev-cognito.example.com");
      expect(config.tenantId).toBe("dev-local");
    });

    it("apiUrl 欠け → env fallback に進むべき", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              cognitoDomain: "https://prod-cognito.example.com",
              userClientId: "prod-client-id",
              tenantId: "tenant-prod-1",
              tenantName: "T",
              deployApiUrl: "https://x",
            }),
            { status: 200 },
          ),
        ),
      );

      const config = await loadConfig(env);
      expect(config.apiBaseUrl).toBe("http://localhost:3999");
    });

    it("deployApiUrl 欠け → env fallback に進むべき", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              cognitoDomain: "https://prod-cognito.example.com",
              userClientId: "prod-client-id",
              tenantId: "tenant-prod-1",
              tenantName: "T",
              apiUrl: "https://a",
            }),
            { status: 200 },
          ),
        ),
      );

      const config = await loadConfig(env);
      expect(config.deployApiBaseUrl).toBe("http://localhost:3998");
    });
  });

  describe("redirectUri", () => {
    it("常に window.location.origin/callback で組み立てられるべき", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));

      const config = await loadConfig(env);
      expect(config.redirectUri).toBe(`${window.location.origin}/callback`);
    });
  });

  describe("scope", () => {
    it("env に指定が無いとき デフォルト 'openid email profile' を返すべき", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));

      const config = await loadConfig(env);
      expect(config.scope).toBe("openid email profile");
    });
  });
});
