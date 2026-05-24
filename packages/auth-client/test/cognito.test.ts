import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginLogin,
  beginLogout,
  type CognitoOAuthConfig,
  clearTokens,
  completeLogin,
  loadStoredTokens,
} from "../src/cognito";

/**
 * Issue #1246: regression coverage for the shared Cognito OAuth client extracted from
 * admin-console + application-admin-console. Asserts behavior is preserved verbatim,
 * including Issue #861 (fail-closed state validation) and Issue #833 (revoke + OIDC
 * logout) guarantees.
 */

const TOKENS_KEY = "TenkaCloud.tokens";
const VERIFIER_KEY = "TenkaCloud.pkce_verifier";
const STATE_KEY = "TenkaCloud.oauth_state";

const CONFIG: CognitoOAuthConfig = {
  cognitoDomain: "https://example-domain.auth.ap-northeast-1.amazoncognito.com",
  cognitoClientId: "client-abc",
  redirectUri: "https://admin.example.com/callback",
  scope: "openid email profile",
};

function storeTokens(refreshToken: string | undefined): void {
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

let assignSpy: ReturnType<typeof vi.fn>;
let fetchSpy: ReturnType<typeof vi.fn>;

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

describe("beginLogin", () => {
  it("should redirect to /oauth2/authorize with PKCE challenge + random state", async () => {
    await beginLogin(CONFIG);
    expect(assignSpy).toHaveBeenCalledTimes(1);
    const url = new URL(assignSpy.mock.calls[0][0] as string);
    expect(url.origin + url.pathname).toBe(`${CONFIG.cognitoDomain}/oauth2/authorize`);
    expect(url.searchParams.get("client_id")).toBe(CONFIG.cognitoClientId);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("redirect_uri")).toBe(CONFIG.redirectUri);
    expect(url.searchParams.get("scope")).toBe(CONFIG.scope);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.get("state")).toBeTruthy();
  });

  it("should persist the PKCE verifier and OAuth state in sessionStorage for later validation", async () => {
    await beginLogin(CONFIG);
    expect(sessionStorage.getItem(VERIFIER_KEY)).toBeTruthy();
    expect(sessionStorage.getItem(STATE_KEY)).toBeTruthy();
  });
});

describe("completeLogin", () => {
  it("should throw when the PKCE verifier is missing (session lost before callback)", async () => {
    await expect(completeLogin(CONFIG, "code-xyz", "state-xyz")).rejects.toThrow(
      /PKCE verifier missing/,
    );
  });

  it("should fail closed when stored state is missing (Issue #861 CSRF defense)", async () => {
    sessionStorage.setItem(VERIFIER_KEY, "verifier-xyz");
    // STATE_KEY intentionally absent
    await expect(completeLogin(CONFIG, "code", "anything")).rejects.toThrow(
      /OAuth state mismatch or missing/,
    );
  });

  it("should fail closed when returned state does not match stored state (CSRF defense)", async () => {
    sessionStorage.setItem(VERIFIER_KEY, "verifier-xyz");
    sessionStorage.setItem(STATE_KEY, "expected-state");
    await expect(completeLogin(CONFIG, "code", "attacker-state")).rejects.toThrow(
      /OAuth state mismatch/,
    );
  });

  it("should exchange the auth code for tokens, persist them, and clear PKCE artifacts on success", async () => {
    sessionStorage.setItem(VERIFIER_KEY, "verifier-xyz");
    sessionStorage.setItem(STATE_KEY, "state-xyz");
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id_token: "id.jwt",
          access_token: "access.jwt",
          refresh_token: "refresh.jwt",
          expires_in: 3600,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const tokens = await completeLogin(CONFIG, "auth-code", "state-xyz");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${CONFIG.cognitoDomain}/oauth2/token`);
    expect(init?.method).toBe("POST");
    const body = init?.body as URLSearchParams;
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("auth-code");
    expect(body.get("code_verifier")).toBe("verifier-xyz");
    expect(body.get("redirect_uri")).toBe(CONFIG.redirectUri);
    expect(body.get("client_id")).toBe(CONFIG.cognitoClientId);

    expect(tokens.idToken).toBe("id.jwt");
    expect(tokens.refreshToken).toBe("refresh.jwt");
    expect(tokens.expiresAt).toBeGreaterThan(Date.now());

    expect(sessionStorage.getItem(VERIFIER_KEY)).toBeNull();
    expect(sessionStorage.getItem(STATE_KEY)).toBeNull();
    expect(sessionStorage.getItem(TOKENS_KEY)).not.toBeNull();
  });

  it("should throw with the Cognito error body when the token endpoint returns non-2xx", async () => {
    sessionStorage.setItem(VERIFIER_KEY, "verifier-xyz");
    sessionStorage.setItem(STATE_KEY, "state-xyz");
    fetchSpy.mockResolvedValueOnce(new Response("invalid_grant", { status: 400 }));

    await expect(completeLogin(CONFIG, "code", "state-xyz")).rejects.toThrow(
      /Cognito token exchange failed \(400\): invalid_grant/,
    );
  });
});

describe("loadStoredTokens / clearTokens", () => {
  it("should round-trip a stored token set that has not expired", () => {
    storeTokens("refresh.jwt");
    const loaded = loadStoredTokens();
    expect(loaded?.accessToken).toBe("access.jwt");
  });

  it("should drop and ignore an expired token set", () => {
    sessionStorage.setItem(
      TOKENS_KEY,
      JSON.stringify({
        idToken: "id",
        accessToken: "access",
        expiresAt: Date.now() - 1,
      }),
    );
    expect(loadStoredTokens()).toBeNull();
    expect(sessionStorage.getItem(TOKENS_KEY)).toBeNull();
  });

  it("should drop and ignore corrupted JSON without throwing", () => {
    sessionStorage.setItem(TOKENS_KEY, "{not json");
    expect(loadStoredTokens()).toBeNull();
    expect(sessionStorage.getItem(TOKENS_KEY)).toBeNull();
  });

  it("should clear tokens, verifier, and state all at once", () => {
    sessionStorage.setItem(TOKENS_KEY, "x");
    sessionStorage.setItem(VERIFIER_KEY, "x");
    sessionStorage.setItem(STATE_KEY, "x");
    clearTokens();
    expect(sessionStorage.getItem(TOKENS_KEY)).toBeNull();
    expect(sessionStorage.getItem(VERIFIER_KEY)).toBeNull();
    expect(sessionStorage.getItem(STATE_KEY)).toBeNull();
  });
});

describe("beginLogout (Issue #833)", () => {
  it("should POST the refresh token to /oauth2/revoke and clear sessionStorage", async () => {
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

  it("should skip /oauth2/revoke when there is no refresh token but still redirect", async () => {
    storeTokens(undefined);
    await beginLogout(CONFIG);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(assignSpy).toHaveBeenCalledTimes(1);
  });

  it("should redirect to /logout with client_id + logout_uri + redirect_uri + response_type=code (OIDC-conformant compatible)", async () => {
    storeTokens("refresh.jwt");
    await beginLogout(CONFIG);
    expect(assignSpy).toHaveBeenCalledTimes(1);
    const redirectedTo = new URL(assignSpy.mock.calls[0][0] as string);
    expect(redirectedTo.origin + redirectedTo.pathname).toBe(`${CONFIG.cognitoDomain}/logout`);
    expect(redirectedTo.searchParams.get("client_id")).toBe(CONFIG.cognitoClientId);
    expect(redirectedTo.searchParams.get("logout_uri")).toBe("https://admin.example.com/login");
    expect(redirectedTo.searchParams.get("redirect_uri")).toBe("https://admin.example.com/login");
    expect(redirectedTo.searchParams.get("response_type")).toBe("code");
  });

  it("should still redirect when /oauth2/revoke fails (= sign-out does not stall on revoke failure)", async () => {
    storeTokens("refresh.jwt");
    fetchSpy.mockRejectedValueOnce(new Error("network down"));
    await beginLogout(CONFIG);
    expect(assignSpy).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(TOKENS_KEY)).toBeNull();
  });
});
