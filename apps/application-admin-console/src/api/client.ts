import { useMemo } from "react";
import { useAuth } from "../auth/AuthProvider";
import type { AppConfig } from "../config";

/**
 * apps/admin-console/src/api/client.ts と同実装 (tenant API 呼び出し用の最小 HTTP client)。
 * 将来 packages/api-client 等に切り出すかは別 Issue。
 */

export interface ApiClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
  patch<T>(path: string, body: unknown): Promise<T>;
  del(path: string): Promise<void>;
  /** 削除系で JSON body を返す経路 (例: bulk teardown の集計結果)。 */
  delJson<T>(path: string): Promise<T>;
}

export function createApiClient(baseUrl: string, idToken: string): ApiClient {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;

  const request = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(path.replace(/^\//, ""), base);
    const res = await fetch(url, {
      ...init,
      headers: {
        authorization: `Bearer ${idToken}`,
        "content-type": "application/json",
        ...init.headers,
      },
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new ApiError(res.status, detail || res.statusText);
    }
    return res;
  };

  return {
    async get<T>(path: string): Promise<T> {
      return (await request(path)).json() as Promise<T>;
    },
    async post<T>(path: string, body: unknown): Promise<T> {
      return (
        await request(path, { method: "POST", body: JSON.stringify(body) })
      ).json() as Promise<T>;
    },
    async patch<T>(path: string, body: unknown): Promise<T> {
      return (
        await request(path, { method: "PATCH", body: JSON.stringify(body) })
      ).json() as Promise<T>;
    },
    async del(path: string): Promise<void> {
      await request(path, { method: "DELETE" });
    },
    async delJson<T>(path: string): Promise<T> {
      return (await request(path, { method: "DELETE" })).json() as Promise<T>;
    },
  };
}

export function useApiClient(config: AppConfig): ApiClient | null {
  const auth = useAuth();
  return useMemo(
    () => (auth.tokens ? createApiClient(config.apiBaseUrl, auth.tokens.idToken) : null),
    [auth.tokens, config.apiBaseUrl],
  );
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(`API ${status}: ${message}`);
    this.name = "ApiError";
  }
}
