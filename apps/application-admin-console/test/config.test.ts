import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config";

afterEach(() => vi.restoreAllMocks());

const env = {
  VITE_COGNITO_DOMAIN: "https://dev-cognito.example.com",
  VITE_COGNITO_CLIENT_ID: "dev-client-id",
};

describe("loadConfig", () => {
  describe("when /runtime-config.json returns all required fields", () => {
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

    it("should take cognitoDomain from runtime-config", async () => {
      expect((await loadWithFullRuntime()).cognitoDomain).toBe(
        "https://prod-tenant.auth.ap-northeast-1.amazoncognito.com",
      );
    });

    it("should take cognitoClientId from runtime-config.userClientId (different key)", async () => {
      expect((await loadWithFullRuntime()).cognitoClientId).toBe("prod-client-id");
    });

    it("should take tenantId from runtime-config", async () => {
      expect((await loadWithFullRuntime()).tenantId).toBe("tenant-prod-1");
    });

    it("should take tenantName from runtime-config", async () => {
      expect((await loadWithFullRuntime()).tenantName).toBe("DENSO 第一事業部");
    });

    it("should take apiBaseUrl from runtime-config.apiUrl (different key)", async () => {
      expect((await loadWithFullRuntime()).apiBaseUrl).toBe("https://prod-api.example.com/prod");
    });
  });

  describe("when /runtime-config.json returns 404 (dev fallback)", () => {
    it("should assemble AppConfig from VITE_COGNITO_* env and DEV_FALLBACK_* placeholders", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
      const config = await loadConfig(env);
      expect(config.cognitoDomain).toBe("https://dev-cognito.example.com");
      expect(config.cognitoClientId).toBe("dev-client-id");
      expect(config.tenantId).toBe("dev-local");
      expect(config.tenantName).toBe("Local Dev Tenant");
      expect(config.apiBaseUrl).toBe("http://localhost:3999");
    });
  });

  describe("when /runtime-config.json is 200 but missing some field", () => {
    it("should fall back to env when cognitoDomain is missing", async () => {
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

    it("should fall back to env when apiUrl is missing", async () => {
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
    it("should fall back to env when apiUrl is http:// (= mixed content / MITM defense)", async () => {
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

    it("should fall back to env when cognitoDomain is not amazoncognito.com (= allowlist)", async () => {
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

    it("should fall back to env when apiUrl is a non-URL such as `javascript:`", async () => {
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
    it("should always be assembled as window.location.origin/callback", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
      const config = await loadConfig(env);
      expect(config.redirectUri).toBe(`${window.location.origin}/callback`);
    });
  });

  describe("scope", () => {
    it("should return default 'openid email profile' when env does not specify it", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
      const config = await loadConfig(env);
      expect(config.scope).toBe("openid email profile");
    });
  });

  // Issue #1340 Phase 2: per-tenant SAML directory が runtime-config から取り出されること。
  describe("samlIdpDirectory (#1340)", () => {
    it("should be empty object when runtime-config does not include the field (= legacy stacks)", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              cognitoDomain: "https://prod-tenant.auth.ap-northeast-1.amazoncognito.com",
              userClientId: "x",
              tenantId: "t",
              tenantName: "n",
              apiUrl: "https://a.example.com",
            }),
            { status: 200 },
          ),
        ),
      );
      const config = await loadConfig(env);
      expect(config.samlIdpDirectory).toEqual({});
    });

    it("should pass through runtime-config.samlIdpDirectory verbatim", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              cognitoDomain: "https://prod-tenant.auth.ap-northeast-1.amazoncognito.com",
              userClientId: "x",
              tenantId: "t",
              tenantName: "n",
              apiUrl: "https://a.example.com",
              samlIdpDirectory: {
                "acme.example": ["tenant-entra"],
              },
            }),
            { status: 200 },
          ),
        ),
      );
      const config = await loadConfig(env);
      expect(config.samlIdpDirectory).toEqual({
        "acme.example": ["tenant-entra"],
      });
    });

    it("should default to empty object in dev fallback (= no /runtime-config.json available)", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
      const config = await loadConfig(env);
      expect(config.samlIdpDirectory).toEqual({});
    });
  });
});
