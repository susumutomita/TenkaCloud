import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { StatusCodes } from "http-status-codes";
import { generatePkcePair, type PkcePair } from "./pkce.ts";

/**
 * Issue #988: Authorization Code + PKCE + loopback flow を CLI 内部で完結させる。
 *
 * 流れ:
 *   1. PKCE pair を生成
 *   2. ephemeral local HTTP server (= 127.0.0.1:RANDOM) を起動
 *   3. Cognito Hosted UI URL (redirect_uri = loopback) をブラウザで開かせる
 *   4. ユーザーがログイン → Cognito が loopback に redirect (authorization_code 付き)
 *   5. local server が code を捕捉 → /oauth2/token を code + verifier で叩いて tokens 取得
 *   6. 取得 tokens を caller に返す
 *
 * Cognito の OAuth flow が前提 (= UserPool Client に loopback callback を許可、
 * Issue #988 の CDK 部分で 別途 client を追加)。
 *
 * 本 module は **Cognito 依存の token 取得 logic と loopback dance だけ** を露出する。
 * caller (= bin/tenkacloud.ts) が CLI 起動順 (browser open / wait / token save) を組む。
 */

export interface CognitoOAuthConfig {
  /** Cognito Hosted UI domain (= https://<prefix>.auth.<region>.amazoncognito.com) */
  readonly hostedUiDomain: string;
  /** UserPool Client ID */
  readonly clientId: string;
  /** Cognito UserPool issuer (= https://cognito-idp.<region>.amazonaws.com/<userPoolId>) */
  readonly issuer: string;
  /** 任意 scope。 default は "openid profile email"。 */
  readonly scope?: string;
}

export interface OAuthTokens {
  readonly accessToken: string;
  readonly idToken: string;
  readonly refreshToken: string;
  /** Unix seconds */
  readonly expiresAt: number;
}

interface LoopbackServerResult {
  readonly server: Server;
  readonly port: number;
  /** authorization_code が来るまで resolve しない */
  readonly waitForCode: () => Promise<string>;
}

function startLoopbackServer(): Promise<LoopbackServerResult> {
  return new Promise((resolve, reject) => {
    let codeResolve: ((code: string) => void) | undefined;
    let codeReject: ((err: Error) => void) | undefined;
    const codePromise = new Promise<string>((res, rej) => {
      codeResolve = res;
      codeReject = rej;
    });

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost`);
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      if (error) {
        res.writeHead(StatusCodes.BAD_REQUEST, { "content-type": "text/plain; charset=utf-8" });
        res.end(`OAuth error: ${error}`);
        codeReject?.(new Error(`OAuth error: ${error}`));
        return;
      }
      if (!code) {
        res.writeHead(StatusCodes.BAD_REQUEST, { "content-type": "text/plain; charset=utf-8" });
        res.end("Missing 'code' query parameter.");
        return;
      }
      res.writeHead(StatusCodes.OK, { "content-type": "text/html; charset=utf-8" });
      res.end(
        "<html><body><h1>TenkaCloud CLI: sign-in 完了</h1><p>このタブを閉じて CLI に戻ってください。</p></body></html>",
      );
      codeResolve?.(code);
    });

    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({
        server,
        port: addr.port,
        waitForCode: () => codePromise,
      });
    });
  });
}

function buildAuthorizationUrl(args: {
  readonly hostedUiDomain: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly pkce: PkcePair;
  readonly scope: string;
  readonly state: string;
}): string {
  const url = new URL(`${args.hostedUiDomain.replace(/\/$/, "")}/oauth2/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", args.clientId);
  url.searchParams.set("redirect_uri", args.redirectUri);
  url.searchParams.set("scope", args.scope);
  url.searchParams.set("code_challenge", args.pkce.challenge);
  url.searchParams.set("code_challenge_method", args.pkce.method);
  url.searchParams.set("state", args.state);
  return url.toString();
}

async function exchangeCodeForTokens(args: {
  readonly hostedUiDomain: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly code: string;
  readonly verifier: string;
}): Promise<OAuthTokens> {
  const url = `${args.hostedUiDomain.replace(/\/$/, "")}/oauth2/token`;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: args.clientId,
    code: args.code,
    redirect_uri: args.redirectUri,
    code_verifier: args.verifier,
  });
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Token exchange failed: HTTP ${res.status} ${text}`);
  }
  const json = (await res.json()) as {
    access_token: string;
    id_token: string;
    refresh_token: string;
    expires_in: number;
  };
  return {
    accessToken: json.access_token,
    idToken: json.id_token,
    refreshToken: json.refresh_token,
    expiresAt: Math.floor(Date.now() / 1000) + json.expires_in,
  };
}

export interface SignInOrchestrator {
  /** ブラウザを開いて URL を表示する callback (= 環境で open / xdg-open / start を差し替え可能) */
  readonly openBrowser: (url: string) => Promise<void>;
  /** ユーザー向けに進捗を出す (= "CLI を開いたまま…") */
  readonly notify: (message: string) => void;
}

/**
 * sign-in flow を 1 関数で完結。 caller は openBrowser / notify を渡すだけ。
 */
export async function signInWithCognito(
  config: CognitoOAuthConfig,
  orchestrator: SignInOrchestrator,
): Promise<OAuthTokens> {
  const pkce = generatePkcePair();
  const state = pkce.verifier.slice(0, 12); // CSRF 簡易 token
  const loopback = await startLoopbackServer();
  const redirectUri = `http://127.0.0.1:${loopback.port}/callback`;
  const scope = config.scope ?? "openid profile email";

  const authUrl = buildAuthorizationUrl({
    hostedUiDomain: config.hostedUiDomain,
    clientId: config.clientId,
    redirectUri,
    pkce,
    scope,
    state,
  });

  orchestrator.notify(`ブラウザを起動します: ${authUrl}`);
  await orchestrator.openBrowser(authUrl);

  try {
    const code = await loopback.waitForCode();
    const tokens = await exchangeCodeForTokens({
      hostedUiDomain: config.hostedUiDomain,
      clientId: config.clientId,
      redirectUri,
      code,
      verifier: pkce.verifier,
    });
    return tokens;
  } finally {
    loopback.server.close();
  }
}
