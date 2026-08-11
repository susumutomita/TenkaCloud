// Issue #1246: re-targets the shared @tenkacloud/auth-client (formerly src/auth/cognito).
// Kept as an integration regression so application-admin-console keeps consumer guarantees.
import {
  clearStoredAuthState,
  completeLogin,
  purgeLegacyTokenStorage,
  type TokenSet,
} from "@tenkacloud/auth-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../../src/config";

const config: AppConfig = {
  cognitoDomain: "https://example.auth.ap-northeast-1.amazoncognito.com",
  cognitoClientId: "abc",
  redirectUri: "http://localhost:5174/callback",
  scope: "openid email",
  tenantId: "tenant-test",
  tenantName: "テスト事業部",
  apiBaseUrl: "https://api.example.com/prod",
  samlIdpDirectory: {},
};

describe("purgeLegacyTokenStorage", () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => sessionStorage.clear()); // don't leak a seeded verifier into completeLogin tests

  it("should evict a bearer token a previous app version persisted to sessionStorage", () => {
    const stale: TokenSet = {
      idToken: "id",
      accessToken: "ac",
      expiresAt: Date.now() + 60_000,
    };
    sessionStorage.setItem("TenkaCloud.tokens", JSON.stringify(stale));
    purgeLegacyTokenStorage();
    expect(sessionStorage.getItem("TenkaCloud.tokens")).toBeNull();
  });

  it("should leave the in-flight PKCE verifier intact so /callback can still complete", () => {
    sessionStorage.setItem("TenkaCloud.pkce_verifier", "v");
    sessionStorage.setItem("TenkaCloud.tokens", "{}");
    purgeLegacyTokenStorage();
    expect(sessionStorage.getItem("TenkaCloud.pkce_verifier")).toBe("v");
    expect(sessionStorage.getItem("TenkaCloud.tokens")).toBeNull();
  });
});

describe("completeLogin", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  describe("when the PKCE verifier is missing from session", () => {
    it("should throw an error", async () => {
      // Issue #873: regex regression を回避。
      await expect(completeLogin(config, "code")).rejects.toMatchObject({
        message: expect.stringContaining("PKCE verifier missing"),
      });
    });
  });

  describe("when Cognito returns 200 with tokens", () => {
    let tokens: TokenSet;
    beforeEach(async () => {
      sessionStorage.setItem("TenkaCloud.pkce_verifier", "v");
      // Issue #861: state validation fail-closed
      sessionStorage.setItem("TenkaCloud.oauth_state", "STATE-OK");
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              id_token: "ID",
              access_token: "AC",
              refresh_token: "RF",
              expires_in: 3600,
            }),
            { status: 200 },
          ),
        ),
      );
      tokens = await completeLogin(config, "code", "STATE-OK");
    });

    it("should store id_token in TokenSet.idToken", () => {
      expect(tokens.idToken).toBe("ID");
    });

    it("should store access_token in TokenSet.accessToken", () => {
      expect(tokens.accessToken).toBe("AC");
    });

    it("should store refresh_token in TokenSet.refreshToken", () => {
      expect(tokens.refreshToken).toBe("RF");
    });

    it("should convert expires_in into a future timestamp (expiresAt)", () => {
      expect(tokens.expiresAt).toBeGreaterThan(Date.now());
    });

    it("should NOT persist tokens to sessionStorage", () => {
      expect(sessionStorage.getItem("TenkaCloud.tokens")).toBeNull();
    });
  });

  describe("when Cognito returns 4xx", () => {
    it("should throw an error containing status and detail", async () => {
      sessionStorage.setItem("TenkaCloud.pkce_verifier", "v");
      sessionStorage.setItem("TenkaCloud.oauth_state", "STATE-OK");
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(new Response("invalid_grant", { status: 400, statusText: "Bad" })),
      );

      await expect(completeLogin(config, "bad", "STATE-OK")).rejects.toMatchObject({
        message: expect.stringMatching(/400.*invalid_grant/),
      });
    });
  });

  describe("Issue #861: state validation fail-closed", () => {
    it("should throw when returnedState does not match", async () => {
      sessionStorage.setItem("TenkaCloud.pkce_verifier", "v");
      sessionStorage.setItem("TenkaCloud.oauth_state", "EXPECTED");
      await expect(completeLogin(config, "code", "ATTACKER")).rejects.toMatchObject({
        message: expect.stringContaining("OAuth state mismatch"),
      });
    });

    it("should throw when session has no state (= close old silent-skip path)", async () => {
      sessionStorage.setItem("TenkaCloud.pkce_verifier", "v");
      await expect(completeLogin(config, "code", "ATTACKER")).rejects.toMatchObject({
        message: expect.stringContaining("OAuth state mismatch"),
      });
    });
  });
});

describe("clearStoredAuthState", () => {
  it("should delete the stored verifier and any legacy token", () => {
    sessionStorage.setItem("TenkaCloud.pkce_verifier", "v");
    sessionStorage.setItem("TenkaCloud.tokens", "{}");
    clearStoredAuthState();
    expect(sessionStorage.getItem("TenkaCloud.pkce_verifier")).toBeNull();
    expect(sessionStorage.getItem("TenkaCloud.tokens")).toBeNull();
  });
});
