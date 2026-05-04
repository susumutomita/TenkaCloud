import type { AppConfig } from "../config";
import { deriveChallenge, generateVerifier } from "./pkce";

const VERIFIER_KEY = "TenkaCloud.pkce_verifier";
const STATE_KEY = "TenkaCloud.oauth_state";
const TOKENS_KEY = "TenkaCloud.tokens";

export interface TokenSet {
  idToken: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

export async function beginLogin(config: AppConfig): Promise<void> {
  const verifier = generateVerifier();
  const challenge = await deriveChallenge(verifier);
  const state = generateVerifier(32);
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  sessionStorage.setItem(STATE_KEY, state);

  const url = new URL(`${config.cognitoDomain}/oauth2/authorize`);
  url.searchParams.set("client_id", config.cognitoClientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", config.scope);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("code_challenge", challenge);

  window.location.assign(url.toString());
}

export async function completeLogin(
  config: AppConfig,
  code: string,
  returnedState?: string,
): Promise<TokenSet> {
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  if (!verifier) throw new Error("PKCE verifier missing (session lost before callback)");

  const expectedState = sessionStorage.getItem(STATE_KEY);
  if (expectedState && returnedState !== expectedState) {
    throw new Error("OAuth state mismatch (possible CSRF attempt)");
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: config.cognitoClientId,
    code,
    redirect_uri: config.redirectUri,
    code_verifier: verifier,
  });

  const res = await fetch(`${config.cognitoDomain}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Cognito token exchange failed (${res.status}): ${detail}`);
  }

  const json = (await res.json()) as {
    id_token: string;
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  sessionStorage.removeItem(VERIFIER_KEY);
  sessionStorage.removeItem(STATE_KEY);

  const tokens: TokenSet = {
    idToken: json.id_token,
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  };
  sessionStorage.setItem(TOKENS_KEY, JSON.stringify(tokens));
  return tokens;
}

export function loadStoredTokens(): TokenSet | null {
  const raw = sessionStorage.getItem(TOKENS_KEY);
  if (!raw) return null;
  try {
    const tokens = JSON.parse(raw) as TokenSet;
    if (tokens.expiresAt <= Date.now()) {
      sessionStorage.removeItem(TOKENS_KEY);
      return null;
    }
    return tokens;
  } catch {
    sessionStorage.removeItem(TOKENS_KEY);
    return null;
  }
}

export function clearTokens(): void {
  sessionStorage.removeItem(TOKENS_KEY);
  sessionStorage.removeItem(VERIFIER_KEY);
  sessionStorage.removeItem(STATE_KEY);
}
