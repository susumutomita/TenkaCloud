import { toErrorMessage } from "./error-message.js";

/**
 * [Issue #2226 ← #2199] Shared core of the admin-console / application-admin-console API
 * clients (Bearer-token HTTP client with `!res.ok -> ApiError` conversion). Both apps'
 * `api/client.ts` previously carried near-identical copies; #2199 demonstrated the risk of that
 * duplication (a fix — network-error normalization — landed on only one side). This module is
 * the single fetch->ApiError conversion implementation; each app's `client.ts` now layers its
 * own app-specific concerns (tenantAccess / demo-client swap for application-admin-console) on
 * top of {@link createCoreApiClient} instead of reimplementing the HTTP plumbing.
 *
 * Method superset (get/post/put/patch/del/delJson): application-admin-console needs all six;
 * admin-console's narrower `ApiClient` interface (get/post/del) is structurally compatible with
 * this return type, so it can use the same core client without exposing the extra methods in its
 * own public type.
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(`API ${status}: ${message}`);
    this.name = "ApiError";
  }
}

export interface CoreApiClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
  put<T>(path: string, body: unknown): Promise<T>;
  patch<T>(path: string, body: unknown): Promise<T>;
  del(path: string): Promise<void>;
  /** Delete route that returns a JSON body (e.g. a bulk-teardown summary). */
  delJson<T>(path: string): Promise<T>;
}

export function createCoreApiClient(baseUrl: string, idToken: string): CoreApiClient {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;

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
      // Issue #1096 / #2199: normalize a fetch-level failure (TypeError from CORS preflight
      // rejection, DNS failure, or an unreachable API) into an ApiError so upper-layer UI can
      // convert it into an operator-friendly "network path error" message. status=0 is the
      // sentinel upper-layer friendly-error mapping uses to detect this case.
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
    async put<T>(path: string, body: unknown): Promise<T> {
      return (
        await request(path, { method: "PUT", body: JSON.stringify(body) })
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
