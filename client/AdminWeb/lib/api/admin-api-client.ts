/**
 * Admin API client — AdminApiStack 経由の各 microservice 呼び出しを共通化する。
 *
 * cloud (runtime-config に adminApiUrl 有り):
 *   `${adminApiUrl}/tenant-management/api/...` のような形でルーティングし、
 *   Cognito ID token を `Authorization: Bearer` で送信する (gateway が JWT 検証)。
 *
 * dev (NEXT_PUBLIC_TENANT_API_BASE_URL 設定済み):
 *   従来通り tenant-management:13004 直叩き。auth-skip で動かす。
 */

import { getCurrentIdToken } from '@/lib/auth/cognito-pkce';
import { loadConfig } from '@/lib/runtime-config';

export type Microservice =
  | 'tenant-management'
  | 'problem-service'
  | 'gameday-service'
  | 'battle-service'
  | 'scoring-service'
  | 'leaderboard-service';

interface Resolved {
  /** 呼び出し先 microservice の base URL (path-prefix まで含む) */
  readonly baseUrl: string;
  /** cloud 環境では Bearer token、dev では空文字 (auth-skip 前提) */
  readonly authHeader: Record<string, string>;
}

async function resolve(
  service: Microservice,
  skipAuth: boolean,
): Promise<Resolved> {
  // dev fallback: NEXT_PUBLIC_TENANT_API_BASE_URL 設定時はそのまま (tenant-management 想定)。
  // 他 service の dev URL は service-health.ts と整合させる。
  const localTenantApi = process.env.NEXT_PUBLIC_TENANT_API_BASE_URL;
  if (localTenantApi && service === 'tenant-management') {
    return {
      baseUrl: localTenantApi.replace(/\/$/, ''),
      authHeader: {},
    };
  }

  const config = await loadConfig();
  if (!config.adminApiUrl) {
    throw new Error(
      `adminApiUrl is not configured. Cannot reach ${service}. ` +
        'In cloud: ensure AdminApiStack is deployed and runtime-config.json has adminApiUrl. ' +
        'In dev: set NEXT_PUBLIC_TENANT_API_BASE_URL or NEXT_PUBLIC_ADMIN_API_BASE_URL.',
    );
  }

  const pathPrefix: Record<Microservice, string> = {
    'tenant-management': '/tenant-management',
    'problem-service': '/problem',
    'gameday-service': '/gameday',
    'battle-service': '/battle',
    'scoring-service': '/scoring',
    'leaderboard-service': '/leaderboard',
  };

  if (skipAuth) {
    return {
      baseUrl: `${config.adminApiUrl}${pathPrefix[service]}`,
      authHeader: {},
    };
  }

  const token = await getCurrentIdToken();
  return {
    baseUrl: `${config.adminApiUrl}${pathPrefix[service]}`,
    authHeader: token ? { Authorization: `Bearer ${token}` } : {},
  };
}

export interface AdminFetchOptions extends Omit<RequestInit, 'headers'> {
  readonly headers?: Record<string, string>;
  /** /health (auth 不要) など Authorization header を付けたくない場合に true */
  readonly skipAuth?: boolean;
}

export async function adminFetch(
  service: Microservice,
  path: string,
  options: AdminFetchOptions = {},
): Promise<Response> {
  const { skipAuth, headers, ...rest } = options;
  const resolved = await resolve(service, skipAuth ?? false);

  return fetch(`${resolved.baseUrl}${path}`, {
    ...rest,
    headers: {
      ...resolved.authHeader,
      ...headers,
    },
  });
}
