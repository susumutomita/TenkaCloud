import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearTokens,
  completeLogin,
  loadStoredTokens,
  type TokenSet,
} from "../../src/auth/cognito";
import type { AppConfig } from "../../src/config";

const config: AppConfig = {
  cognitoDomain: "https://example.auth.ap-northeast-1.amazoncognito.com",
  cognitoClientId: "abc",
  redirectUri: "http://localhost:5174/callback",
  scope: "openid email",
  tenantId: "tenant-test",
  tenantName: "テスト事業部",
  apiBaseUrl: "https://api.example.com/prod",
};

describe("loadStoredTokens", () => {
  beforeEach(() => sessionStorage.clear());

  describe("sessionStorage にトークンが無いとき", () => {
    it("null を返すべき", () => {
      expect(loadStoredTokens()).toBeNull();
    });
  });

  describe("保存されたトークンが既に expire しているとき", () => {
    it("null を返すべき", () => {
      const expired: TokenSet = {
        idToken: "id",
        accessToken: "ac",
        expiresAt: Date.now() - 1,
      };
      sessionStorage.setItem("TenkaCloud.tokens", JSON.stringify(expired));
      expect(loadStoredTokens()).toBeNull();
    });
  });

  describe("有効なトークンが保存されているとき", () => {
    it("その TokenSet を返すべき", () => {
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

  describe("PKCE verifier が session に無いとき", () => {
    it("エラーを投げるべき", async () => {
      // Issue #873: regex regression を回避。
      await expect(completeLogin(config, "code")).rejects.toMatchObject({
        message: expect.stringContaining("PKCE verifier missing"),
      });
    });
  });

  describe("Cognito が 200 とトークンを返したとき", () => {
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

    it("id_token を TokenSet.idToken に入れるべき", () => {
      expect(tokens.idToken).toBe("ID");
    });

    it("access_token を TokenSet.accessToken に入れるべき", () => {
      expect(tokens.accessToken).toBe("AC");
    });

    it("refresh_token を TokenSet.refreshToken に入れるべき", () => {
      expect(tokens.refreshToken).toBe("RF");
    });

    it("expires_in を未来時刻 (expiresAt) に換算するべき", () => {
      expect(tokens.expiresAt).toBeGreaterThan(Date.now());
    });

    it("トークンを sessionStorage に永続化するべき", () => {
      expect(loadStoredTokens()?.idToken).toBe("ID");
    });
  });

  describe("Cognito が 4xx を返したとき", () => {
    it("ステータスと detail を含むエラーを投げるべき", async () => {
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
    it("returnedState 不一致は throw", async () => {
      sessionStorage.setItem("TenkaCloud.pkce_verifier", "v");
      sessionStorage.setItem("TenkaCloud.oauth_state", "EXPECTED");
      await expect(completeLogin(config, "code", "ATTACKER")).rejects.toMatchObject({
        message: expect.stringContaining("OAuth state mismatch"),
      });
    });

    it("session に state が無いと throw (= 旧 silent skip を塞ぐ)", async () => {
      sessionStorage.setItem("TenkaCloud.pkce_verifier", "v");
      await expect(completeLogin(config, "code", "ATTACKER")).rejects.toMatchObject({
        message: expect.stringContaining("OAuth state mismatch"),
      });
    });
  });
});

describe("clearTokens", () => {
  it("保存された verifier とトークンを両方削除すべき", () => {
    sessionStorage.setItem("TenkaCloud.pkce_verifier", "v");
    sessionStorage.setItem("TenkaCloud.tokens", "{}");
    clearTokens();
    expect(sessionStorage.getItem("TenkaCloud.pkce_verifier")).toBeNull();
    expect(sessionStorage.getItem("TenkaCloud.tokens")).toBeNull();
  });
});
