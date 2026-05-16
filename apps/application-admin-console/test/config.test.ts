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
                cognitoDomain: "https://prod-tenant.auth.ap-northeast-1.amazoncognito.com",
                userClientId: "prod-client-id",
                tenantId: "tenant-prod-1",
                tenantName: "DENSO 第一事業部",
                apiUrl: "https://prod-api.example.com/prod",
              }),
              { status: 200 },
            ),
          ),
        ),
      );
      return loadConfig(env);
    }

    it("cognitoDomain を runtime-config から取るべき", async () => {
      expect((await loadWithFullRuntime()).cognitoDomain).toBe(
        "https://prod-tenant.auth.ap-northeast-1.amazoncognito.com",
      );
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
            { status: 200 },
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
            }),
            { status: 200 },
          ),
        ),
      );
      const config = await loadConfig(env);
      expect(config.apiBaseUrl).toBe("http://localhost:3999");
    });
  });

  describe("Issue #871: runtime-config.json validation", () => {
    it("apiUrl が http:// なら env fallback に倒れるべき (= mixed content / MITM 防御)", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              cognitoDomain: "https://prod-tenant.auth.ap-northeast-1.amazoncognito.com",
              userClientId: "x",
              tenantId: "t",
              tenantName: "n",
              apiUrl: "http://attacker.evil.com/",
            }),
            { status: 200 },
          ),
        ),
      );
      const config = await loadConfig(env);
      expect(config.apiBaseUrl).toBe("http://localhost:3999");
    });

    it("cognitoDomain が amazoncognito.com 以外なら env fallback に倒れるべき (= allowlist)", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              cognitoDomain: "https://attacker-cognito.evil.com",
              userClientId: "x",
              tenantId: "t",
              tenantName: "n",
              apiUrl: "https://api.example.com",
            }),
            { status: 200 },
          ),
        ),
      );
      const config = await loadConfig(env);
      expect(config.cognitoDomain).toBe("https://dev-cognito.example.com");
    });

    it("apiUrl が `javascript:` などの非 URL ならは env fallback に倒れるべき", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              cognitoDomain: "https://prod-tenant.auth.ap-northeast-1.amazoncognito.com",
              userClientId: "x",
              tenantId: "t",
              tenantName: "n",
              apiUrl: "javascript:alert(1)",
            }),
            { status: 200 },
          ),
        ),
      );
      const config = await loadConfig(env);
      expect(config.apiBaseUrl).toBe("http://localhost:3999");
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
