import { toErrorMessage } from "@tenkacloud/web-kit";
import { useMemo } from "react";
import { useAuth } from "../auth/AuthProvider";
import type { AppConfig } from "../config";

export interface ApiClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
  del(path: string): Promise<void>;
}

export function createApiClient(config: AppConfig, idToken: string): ApiClient {
  const base = config.apiBaseUrl.endsWith("/") ? config.apiBaseUrl : `${config.apiBaseUrl}/`;

  const request = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(path.replace(/^\//, ""), base);
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        headers: {
          authorization: `Bearer ${idToken}`,
          "content-type": "application/json",
          ...init.headers,
        },
      });
    } catch (err) {
      // Issue #1096 (ported from application-admin-console, #2199): normalize a
      // fetch-level failure (TypeError from CORS preflight / network unreachable /
      // API not present) into an ApiError so upper-layer UI can convert it into an
      // operator-friendly "network path error" message. status=0 is the sentinel
      // upper-layer friendly-error mapping uses to detect this case.
      const detail = toErrorMessage(err);
      throw new ApiError(
        0,
        `Network error: ${detail} (URL: ${url.toString()}, method: ${init.method ?? "GET"})`,
      );
    }
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
    async del(path: string): Promise<void> {
      await request(path, { method: "DELETE" });
    },
  };
}

export function useApiClient(config: AppConfig): ApiClient | null {
  const auth = useAuth();
  return useMemo(
    () => (auth.tokens ? createApiClient(config, auth.tokens.idToken) : null),
    [auth.tokens, config],
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
