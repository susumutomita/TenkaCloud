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
