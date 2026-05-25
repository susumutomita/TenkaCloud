import { StatusCodes } from "http-status-codes";
import { getValidTokens, RefreshError } from "../auth/refresh.ts";

/**
 * Issue #1305: 認証付き fetch wrapper。
 *
 * 機能:
 *   - credential store から token を読む。 expiry が近ければ自動 refresh。
 *   - Authorization: Bearer <accessToken> を自動付与。
 *   - HTTP error をユーザー向けエラーに mapping (401 / 403 / 404 / 5xx)。
 *   - **Bearer は log に絶対書かない**。
 *
 * 戻り値は parsed JSON。 caller 側 schema 判定はそれぞれの API module で。
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly userMessage: string,
    readonly body?: unknown,
  ) {
    super(userMessage);
    this.name = "ApiError";
  }
}

export interface FetchAuthConfig {
  readonly hostedUiDomain: string;
  readonly fetchImpl?: typeof fetch;
  readonly nowSec?: () => number;
}

export interface FetchOptions {
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly body?: unknown;
  readonly query?: Record<string, string | number | undefined>;
  readonly headers?: Record<string, string>;
}

function buildUrl(base: string, path: string, query?: FetchOptions["query"]): string {
  const url = new URL(path.startsWith("/") ? path : `/${path}`, `${base.replace(/\/$/, "")}/`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

function mapStatusToUserMessage(status: number, resource: string): string {
  if (status === StatusCodes.UNAUTHORIZED) {
    return "認証が必要です。 `tenkacloud login` を実行してください";
  }
  if (status === StatusCodes.FORBIDDEN) {
    return "権限がありません (= 要 role を確認してください: SystemAdmin / TenantAdmin)";
  }
  if (status === StatusCodes.NOT_FOUND) {
    return `対象が見つかりません: ${resource}`;
  }
  if (status >= 500) {
    return `サーバーエラー (HTTP ${status})。 再試行してください`;
  }
  return `API error (HTTP ${status}): ${resource}`;
}

export async function fetchWithAuth(
  baseUrl: string,
  path: string,
  options: FetchOptions = {},
  authConfig: FetchAuthConfig,
): Promise<unknown> {
  const fetchImpl = authConfig.fetchImpl ?? fetch;
  let tokens: Awaited<ReturnType<typeof getValidTokens>>;
  try {
    tokens = await getValidTokens({
      hostedUiDomain: authConfig.hostedUiDomain,
      fetchImpl: authConfig.fetchImpl,
      nowSec: authConfig.nowSec,
    });
  } catch (err) {
    if (err instanceof RefreshError) {
      throw new ApiError(
        StatusCodes.UNAUTHORIZED,
        "認証が必要です。 `tenkacloud login` を実行してください",
        { cause: err.message },
      );
    }
    throw err;
  }
  if (!tokens) {
    throw new ApiError(
      StatusCodes.UNAUTHORIZED,
      "認証が必要です。 `tenkacloud login` を実行してください",
    );
  }

  const url = buildUrl(baseUrl, path, options.query);
  const headers: Record<string, string> = {
    accept: "application/json",
    authorization: `Bearer ${tokens.accessToken}`,
    ...(options.headers ?? {}),
  };
  let body: string | undefined;
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.body);
  }

  const res = await fetchImpl(url, {
    method: options.method ?? "GET",
    headers,
    body,
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => undefined);
    throw new ApiError(res.status, mapStatusToUserMessage(res.status, path), errBody);
  }

  if (res.status === StatusCodes.NO_CONTENT) return undefined;
  const text = await res.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
