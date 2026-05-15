import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config";
import { beginLogout } from "./cognito";

/**
 * Issue #833: サインアウト時に Cognito Hosted UI session が revoke されず、
 * 再 sign-in で Cognito を経由せず画面に入れてしまう問題の回帰防止テスト。
 */

const TOKENS_KEY = "TenkaCloud.tokens";

const CONFIG: AppConfig = {
  cognitoDomain: "https://tenant-domain.auth.ap-northeast-1.amazoncognito.com",
  cognitoClientId: "tenant-client",
  redirectUri: "https://app.example.com/callback",
  scope: "openid email profile",
  tenantId: "01HZZ",
  tenantName: "Acme",
  apiBaseUrl: "https://api.example.com",
};

function storeTokens(refreshToken: string | undefined) {
  sessionStorage.setItem(
    TOKENS_KEY,
    JSON.stringify({
      idToken: "id.jwt",
      accessToken: "access.jwt",
      refreshToken,
      expiresAt: Date.now() + 60_000,
    }),
  );
}

describe("beginLogout (Issue #833)", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let assignSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sessionStorage.clear();
    fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    assignSpy = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, assign: assignSpy },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("refresh token を /oauth2/revoke に POST してから sessionStorage を clear すべき", async () => {
    storeTokens("refresh.jwt");

    await beginLogout(CONFIG);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${CONFIG.cognitoDomain}/oauth2/revoke`);
    expect(init?.method).toBe("POST");
    const body = init?.body as URLSearchParams;
    expect(body.get("token")).toBe("refresh.jwt");
    expect(body.get("client_id")).toBe(CONFIG.cognitoClientId);
    expect(sessionStorage.getItem(TOKENS_KEY)).toBeNull();
  });

  it("refresh token が無いときは /oauth2/revoke を呼ばずに redirect すべき", async () => {
    storeTokens(undefined);

    await beginLogout(CONFIG);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(assignSpy).toHaveBeenCalledTimes(1);
  });

  it("/logout に client_id と logout_uri を付けて redirect すべき", async () => {
    storeTokens("refresh.jwt");

    await beginLogout(CONFIG);

    expect(assignSpy).toHaveBeenCalledTimes(1);
    const redirectedTo = new URL(assignSpy.mock.calls[0][0] as string);
    expect(redirectedTo.origin + redirectedTo.pathname).toBe(`${CONFIG.cognitoDomain}/logout`);
    expect(redirectedTo.searchParams.get("client_id")).toBe(CONFIG.cognitoClientId);
    expect(redirectedTo.searchParams.get("logout_uri")).toBe("https://app.example.com/login");
  });

  it("/oauth2/revoke が失敗しても redirect は実行されるべき (= revoke failure で sign-out が止まらない)", async () => {
    storeTokens("refresh.jwt");
    fetchSpy.mockRejectedValueOnce(new Error("network down"));

    await beginLogout(CONFIG);

    expect(assignSpy).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(TOKENS_KEY)).toBeNull();
  });
});
