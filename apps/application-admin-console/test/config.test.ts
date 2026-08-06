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
                tenantName: "Acme Manufacturing Division",
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
      expect((await loadWithFullRuntime()).tenantName).toBe("Acme Manufacturing Division");
    });

    it("should take apiBaseUrl from runtime-config.apiUrl (different key)", async () => {
      expect((await loadWithFullRuntime()).apiBaseUrl).toBe("https://prod-api.example.com/prod");
    });

    it("should default features OFF when runtime-config omits the features object", async () => {
      expect((await loadWithFullRuntime()).features).toEqual({
        samlSso: false,
        nonAwsRuntime: false,
        redTeam: true,
        challengePrerequisiteGate: false,
      });
    });

    it("should resolve features from a runtime-config features override object", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              cognitoDomain: "https://prod-tenant.auth.ap-northeast-1.amazoncognito.com",
              userClientId: "prod-client-id",
              tenantId: "tenant-prod-1",
              tenantName: "tenant",
              apiUrl: "https://prod-api.example.com/prod",
              features: { samlSso: true, nonAwsRuntime: true, redTeam: false },
            }),
            { status: 200 },
          ),
        ),
      );
      expect((await loadConfig(env)).features).toEqual({
        samlSso: true,
        nonAwsRuntime: true,
        redTeam: false,
        challengePrerequisiteGate: false,
      });
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

    it("should fall back to env when the fetch itself throws (= offline / network error)", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
      const config = await loadConfig(env);
      expect(config.tenantId).toBe("dev-local");
    });

    it("should default all features OFF when VITE_FEATURES is absent", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
      const config = await loadConfig(env);
      expect(config.features).toEqual({
        samlSso: false,
        nonAwsRuntime: false,
        redTeam: true,
        challengePrerequisiteGate: false,
      });
    });

    it("should opt features in from a VITE_FEATURES JSON object", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
      const config = await loadConfig({ ...env, VITE_FEATURES: '{"samlSso":true}' });
      expect(config.features).toEqual({
        samlSso: true,
        nonAwsRuntime: false,
        redTeam: true,
        challengePrerequisiteGate: false,
      });
    });

    it("should ignore invalid / non-object VITE_FEATURES and use defaults", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
      const bad = await loadConfig({ ...env, VITE_FEATURES: "not-json" });
      expect(bad.features).toEqual({
        samlSso: false,
        nonAwsRuntime: false,
        redTeam: true,
        challengePrerequisiteGate: false,
      });
      const arr = await loadConfig({ ...env, VITE_FEATURES: "[1,2]" });
      expect(arr.features).toEqual({
        samlSso: false,
        nonAwsRuntime: false,
        redTeam: true,
        challengePrerequisiteGate: false,
      });
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

  describe("optional runtime-config fields + isolation", () => {
    function loadWithRuntime(extra: Record<string, unknown>) {
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
              ...extra,
            }),
            { status: 200 },
          ),
        ),
      );
      return loadConfig(env);
    }

    it("should pass through string participantPortalUrl / competitorBootstrapTemplateUrl and isolation=silo", async () => {
      const config = await loadWithRuntime({
        participantPortalUrl: "https://portal.example.com",
        competitorBootstrapTemplateUrl: "https://s3.example/bootstrap.yaml",
        isolation: "silo",
      });
      expect(config.participantPortalUrl).toBe("https://portal.example.com");
      expect(config.competitorBootstrapTemplateUrl).toBe("https://s3.example/bootstrap.yaml");
      expect(config.isolation).toBe("silo");
    });

    it("should drop non-string optional URLs to undefined and non-silo isolation to pooled", async () => {
      const config = await loadWithRuntime({
        participantPortalUrl: 123,
        competitorBootstrapTemplateUrl: false,
        isolation: "bogus",
      });
      expect(config.participantPortalUrl).toBeUndefined();
      expect(config.competitorBootstrapTemplateUrl).toBeUndefined();
      expect(config.isolation).toBe("pooled");
    });
  });

  describe("dev env fallback path", () => {
    it("should honor VITE_ISOLATION=silo when assembling from env", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
      const config = await loadConfig({ ...env, VITE_ISOLATION: "silo" });
      expect(config.isolation).toBe("silo");
    });

    it("should throw when a required env var is missing in the fallback path", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
      let threw = false;
      try {
        await loadConfig({});
      } catch (e) {
        threw = true;
        expect((e as Error).message).toMatch(/Missing required env var/);
      }
      expect(threw).toBe(true);
    });
  });
});
