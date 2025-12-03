/**
 * API Client
 *
 * バックエンド API 呼び出しの共通設定（参加者向け）
 */

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080/api";

interface FetchOptions extends RequestInit {
  params?: Record<string, string | number | boolean | undefined>;
}

/**
 * 認証トークンを取得
 *
 * TODO: Keycloak 統合後に NextAuth セッションからトークンを取得
 * @see frontend/control-plane/lib/api/client.ts の実装を参考
 */
async function getAuthToken(): Promise<string | null> {
  // Keycloak 統合後は以下のように実装:
  // const session = await getSession();
  // return session?.accessToken ?? null;

  // 現在は未認証状態を返す（API 側で適切に処理される想定）
  return null;
}

/**
 * API リクエスト
 */
export async function apiRequest<T>(
  endpoint: string,
  options: FetchOptions = {},
): Promise<T> {
  const { params, ...fetchOptions } = options;

  // クエリパラメータを構築
  let url = `${API_BASE_URL}${endpoint}`;
  if (params) {
    const searchParams = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined) {
        searchParams.append(key, String(value));
      }
    });
    const queryString = searchParams.toString();
    if (queryString) {
      url += `?${queryString}`;
    }
  }

  // 認証トークンを取得
  const token = await getAuthToken();

  const response = await fetch(url, {
    ...fetchOptions,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...fetchOptions.headers,
    },
  });

  if (!response.ok) {
    const error = await response
      .json()
      .catch(() => ({ error: "Unknown error" }));
    throw new Error(error.error || `HTTP error! status: ${response.status}`);
  }

  return response.json();
}

/**
 * GET リクエスト
 */
export async function get<T>(
  endpoint: string,
  params?: Record<string, string | number | boolean | undefined>,
): Promise<T> {
  return apiRequest<T>(endpoint, { method: "GET", params });
}

/**
 * POST リクエスト
 */
export async function post<T>(endpoint: string, data?: unknown): Promise<T> {
  return apiRequest<T>(endpoint, {
    method: "POST",
    body: data ? JSON.stringify(data) : undefined,
  });
}

/**
 * PUT リクエスト
 */
export async function put<T>(endpoint: string, data?: unknown): Promise<T> {
  return apiRequest<T>(endpoint, {
    method: "PUT",
    body: data ? JSON.stringify(data) : undefined,
  });
}

/**
 * PATCH リクエスト
 */
export async function patch<T>(endpoint: string, data?: unknown): Promise<T> {
  return apiRequest<T>(endpoint, {
    method: "PATCH",
    body: data ? JSON.stringify(data) : undefined,
  });
}

/**
 * DELETE リクエスト
 */
export async function del<T>(endpoint: string): Promise<T> {
  return apiRequest<T>(endpoint, { method: "DELETE" });
}
