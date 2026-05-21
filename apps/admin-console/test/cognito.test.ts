import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearTokens, completeLogin, loadStoredTokens, type TokenSet } from "../src/auth/cognito";
import type { AppConfig } from "../src/config";

const config: AppConfig = {
  cognitoDomain: "https://example.auth.ap-northeast-1.amazoncognito.com",
  cognitoClientId: "abc",
  redirectUri: "http://localhost:5173/callback",
  apiBaseUrl: "https://api.example.com",
  scope: "openid email",
  pooledApplicationAdminConsoleUrl: "",
  provisioningCodeBuildProject: "unknown",
  awsRegion: "",
  awsAccountId: "",
  adminInsightApiUrl: "",
  cloudWatchDashboardName: "",
};

describe("loadStoredTokens", () => {
  beforeEach(() => sessionStorage.clear());

  describe("when there is no token in sessionStorage", () => {
    it("should return null", () => {
      expect(loadStoredTokens()).toBeNull();
    });
  });

  describe("when the stored token has already expired", () => {
    it("should return null", () => {
      const expired: TokenSet = {
        idToken: "id",
        accessToken: "ac",
        expiresAt: Date.now() - 1,
      };
      sessionStorage.setItem("TenkaCloud.tokens", JSON.stringify(expired));
      expect(loadStoredTokens()).toBeNull();
    });
  });

  describe("when a valid token is stored", () => {
    it("should return that TokenSet", () => {
      const valid: TokenSet = {
        idToken: "id",
        accessToken: "ac",
        expiresAt: Date.now() + 60_000,
      };
      sessionStorage.setItem("TenkaCloud.tokens", JSON.stringify(valid));
      expect(loadStoredTokens()).toEqual(valid);
    });
  });
});

describe("completeLogin", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  describe("when the PKCE verifier is missing from the session", () => {
    it("should throw an error", async () => {
      // Issue #873: vitest 4.x で `.rejects.toThrow(/regex/)` の message 照合 regression あり。
      await expect(completeLogin(config, "code")).rejects.toMatchObject({
        message: expect.stringContaining("PKCE verifier missing"),
      });
    });
  });

  describe("when Cognito returns 200 with tokens", () => {
    let tokens: TokenSet;
    beforeEach(async () => {
      sessionStorage.setItem("TenkaCloud.pkce_verifier", "v");
      // Issue #861: state validation が fail-closed になったので、 valid な state を inject。
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

    it("should put id_token into TokenSet.idToken", () => {
      expect(tokens.idToken).toBe("ID");
    });

    it("should put access_token into TokenSet.accessToken", () => {
      expect(tokens.accessToken).toBe("AC");
    });

    it("should put refresh_token into TokenSet.refreshToken", () => {
      expect(tokens.refreshToken).toBe("RF");
    });

    it("should convert expires_in into a future timestamp (expiresAt)", () => {
      expect(tokens.expiresAt).toBeGreaterThan(Date.now());
    });

    it("should persist tokens to sessionStorage", () => {
      expect(loadStoredTokens()?.idToken).toBe("ID");
    });
  });

  describe("when Cognito returns 4xx", () => {
    it("should throw an error including the status and detail", async () => {
      sessionStorage.setItem("TenkaCloud.pkce_verifier", "v");
      // Issue #861: state validation 経由で state を渡す。
      sessionStorage.setItem("TenkaCloud.oauth_state", "STATE-OK");
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(new Response("invalid_grant", { status: 400, statusText: "Bad" })),
      );

      // Issue #861 + #873: state validation 経由で state を渡しつつ、 vitest 4.x regex
      // regression を回避するため toMatchObject で message を照合する。
      await expect(completeLogin(config, "bad", "STATE-OK")).rejects.toMatchObject({
        message: expect.stringMatching(/400.*invalid_grant/),
      });
    });
  });

  describe("Issue #861: state validation fail-closed", () => {
    it("should throw when returnedState does not match", async () => {
      sessionStorage.setItem("TenkaCloud.pkce_verifier", "v");
      sessionStorage.setItem("TenkaCloud.oauth_state", "EXPECTED");
      await expect(completeLogin(config, "code", "ATTACKER-STATE")).rejects.toMatchObject({
        message: expect.stringContaining("OAuth state mismatch"),
      });
    });

    it("should throw when state is missing from sessionStorage (= session clear / CSRF path)", async () => {
      sessionStorage.setItem("TenkaCloud.pkce_verifier", "v");
      // STATE_KEY を入れない
      await expect(completeLogin(config, "code", "ATTACKER-STATE")).rejects.toMatchObject({
        message: expect.stringContaining("OAuth state mismatch"),
      });
    });

    it("should throw even when returnedState is not specified (= closes the old silent-skip bypass)", async () => {
      sessionStorage.setItem("TenkaCloud.pkce_verifier", "v");
      sessionStorage.setItem("TenkaCloud.oauth_state", "EXPECTED");
      await expect(completeLogin(config, "code")).rejects.toMatchObject({
        message: expect.stringContaining("OAuth state mismatch"),
      });
    });
  });
});

describe("clearTokens", () => {
  it("should delete both the stored verifier and the tokens", () => {
    sessionStorage.setItem("TenkaCloud.pkce_verifier", "v");
    sessionStorage.setItem("TenkaCloud.tokens", "{}");
    clearTokens();
    expect(sessionStorage.getItem("TenkaCloud.pkce_verifier")).toBeNull();
    expect(sessionStorage.getItem("TenkaCloud.tokens")).toBeNull();
  });
});
