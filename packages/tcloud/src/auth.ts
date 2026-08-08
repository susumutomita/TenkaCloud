import { type CachedToken, expiryFromExpiresIn, type TokenStore } from "./token-store.js";

/**
 * Issue #2951: Cognito の `client_credentials` で access token を取る。
 *
 * token endpoint には HTTP Basic (client id + secret) で認証する。要求する scope は
 * capability scope に加えて **tenant binding scope** を必ず含める。binding が 1 件ちょうど
 * 無い token は platform 側で machine principal として解決されない。
 */

export class TokenRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly oauthError: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "TokenRequestError";
  }
}

export interface TokenRequest {
  readonly tokenUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly scopes: readonly string[];
}

/**
 * `fetch` の必要最小限だけを要求する形。`body` が optional なのは、machine API 側の GET が
 * body を持たないため (= 同じ関数を token endpoint と API client の両方に渡せる)。
 */
export type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

function basicAuthHeader(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
}

/** 人間に読める形へ翻訳する。`invalid_scope` はここでいちばんよく出る。 */
function describeTokenFailure(status: number, oauthError: string | undefined): string {
  if (oauthError === "invalid_scope") {
    return (
      "token endpoint が scope を拒否しました (invalid_scope)。この client に許可されていない " +
      "capability を要求したか、tenant の binding scope が一致していません。" +
      "`scripts/issue-machine-client.sh list` で client の scope を確認してください。"
    );
  }
  if (oauthError === "invalid_client" || status === 401) {
    return "client id / client secret が正しくありません (invalid_client)。";
  }
  return `token endpoint が ${status} を返しました${oauthError ? ` (${oauthError})` : ""}。`;
}

export async function requestAccessToken(
  request: TokenRequest,
  nowMs: number,
  fetchImpl: FetchLike,
): Promise<CachedToken> {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    scope: request.scopes.join(" "),
  }).toString();

  const response = await fetchImpl(request.tokenUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: basicAuthHeader(request.clientId, request.clientSecret),
    },
    body,
  });

  const raw = await response.text();
  if (!response.ok) {
    let oauthError: string | undefined;
    try {
      const parsed = JSON.parse(raw) as { error?: unknown };
      if (typeof parsed.error === "string") oauthError = parsed.error;
    } catch {
      // token endpoint が JSON を返さないケース。status だけで説明する。
    }
    throw new TokenRequestError(
      response.status,
      oauthError,
      describeTokenFailure(response.status, oauthError),
    );
  }

  const parsed = JSON.parse(raw) as { access_token?: unknown; expires_in?: unknown };
  if (typeof parsed.access_token !== "string" || typeof parsed.expires_in !== "number") {
    throw new TokenRequestError(
      response.status,
      undefined,
      "token endpoint の応答に access_token / expires_in がありません。",
    );
  }
  return {
    accessToken: parsed.access_token,
    expiresAtMs: expiryFromExpiresIn(nowMs, parsed.expires_in),
  };
}

/** cache key。同じ client でも要求 scope が違えば別 token なので scope も混ぜる。 */
export function cacheKey(clientId: string, scopes: readonly string[]): string {
  return `${clientId}#${[...scopes].sort().join(" ")}`;
}

export interface ResolveTokenResult {
  readonly token: CachedToken;
  /** cache から返したなら true (= token endpoint を叩いていない)。 */
  readonly fromCache: boolean;
}

/**
 * cache を優先して token を得る。cache が無い / 期限切れのときだけ token endpoint を叩く。
 *
 * secret が無く cache も使えない場合は、何が足りないかを言って失敗する。ここで黙って
 * 空 token を返すと、後段が 401 になって原因が分からなくなる。
 */
export async function resolveAccessToken(args: {
  readonly store: TokenStore;
  readonly clientId: string;
  readonly clientSecret: string | undefined;
  readonly tokenUrl: string;
  readonly scopes: readonly string[];
  readonly nowMs: number;
  readonly fetchImpl: FetchLike;
}): Promise<ResolveTokenResult> {
  const key = cacheKey(args.clientId, args.scopes);
  const cached = args.store.read(key, args.nowMs);
  if (cached) return { token: cached, fromCache: true };

  if (!args.clientSecret) {
    throw new TokenRequestError(
      0,
      undefined,
      "cache に有効な token が無く、client secret もありません。" +
        "`tcloud auth login --client-id <id> --client-secret <secret>` を実行するか、" +
        "TCLOUD_CLIENT_SECRET を設定してください。",
    );
  }

  const token = await requestAccessToken(
    {
      tokenUrl: args.tokenUrl,
      clientId: args.clientId,
      clientSecret: args.clientSecret,
      scopes: args.scopes,
    },
    args.nowMs,
    args.fetchImpl,
  );
  args.store.write(key, token);
  return { token, fromCache: false };
}
