/**
 * Runtime config — production では CloudFront 同ドメインの `/runtime-config.json` から
 * 読む。AdminConsoleHostingStack が CDK deploy 時に配置する。
 *
 * dev では env から読む (NEXT_PUBLIC_* prefix で client にも露出させる)。
 */

import { withControlBasePath } from './base-path';

export interface AppConfig {
  readonly cognitoDomain: string;
  readonly cognitoClientId: string;
  readonly redirectUri: string;
  readonly apiBaseUrl: string;
  readonly scope: string;
  /**
   * AdminApiStack の HTTP API Gateway URL (各 microservice のフロント、Cognito JWT 保護)。
   * cloud deploy 時のみ存在 (runtime-config.json に adminApiUrl があれば伝播)。
   * 未設定なら dev fallback (NEXT_PUBLIC_ADMIN_API_BASE_URL) を見る。
   */
  readonly adminApiUrl?: string;
}

interface RuntimeConfig {
  readonly apiUrl: string;
  readonly cognitoDomain: string;
  readonly userClientId: string;
  readonly adminApiUrl?: string;
}

let cachedConfig: AppConfig | null = null;
let inflight: Promise<AppConfig> | null = null;

async function fetchRuntimeConfig(): Promise<RuntimeConfig | null> {
  try {
    const res = await fetch('/runtime-config.json', { cache: 'no-store' });
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<RuntimeConfig>;
    if (!data.apiUrl || !data.cognitoDomain || !data.userClientId) return null;
    return {
      apiUrl: data.apiUrl,
      cognitoDomain: data.cognitoDomain,
      userClientId: data.userClientId,
      ...(data.adminApiUrl ? { adminApiUrl: data.adminApiUrl } : {}),
    };
  } catch {
    return null;
  }
}

function resolveRedirectUri(): string {
  return `${window.location.origin}${withControlBasePath('/callback')}`;
}

function resolveScope(): string {
  return process.env.NEXT_PUBLIC_COGNITO_SCOPE ?? 'openid email profile';
}

function devFallback(): AppConfig | null {
  const env = process.env;
  const cognitoDomain = env.NEXT_PUBLIC_COGNITO_DOMAIN;
  const clientId = env.NEXT_PUBLIC_COGNITO_CLIENT_ID;
  const apiBaseUrl = env.NEXT_PUBLIC_API_BASE_URL;
  if (!cognitoDomain || !clientId || !apiBaseUrl) return null;
  const adminApiUrl = env.NEXT_PUBLIC_ADMIN_API_BASE_URL;
  return {
    cognitoDomain,
    cognitoClientId: clientId,
    apiBaseUrl,
    redirectUri: resolveRedirectUri(),
    scope: resolveScope(),
    ...(adminApiUrl ? { adminApiUrl } : {}),
  };
}

export async function loadConfig(): Promise<AppConfig> {
  if (cachedConfig) return cachedConfig;
  if (inflight) return inflight;

  inflight = (async () => {
    const runtime = await fetchRuntimeConfig();
    if (runtime) {
      cachedConfig = {
        cognitoDomain: runtime.cognitoDomain,
        cognitoClientId: runtime.userClientId,
        apiBaseUrl: runtime.apiUrl.replace(/\/$/, ''),
        redirectUri: resolveRedirectUri(),
        scope: resolveScope(),
        ...(runtime.adminApiUrl
          ? { adminApiUrl: runtime.adminApiUrl.replace(/\/$/, '') }
          : {}),
      };
      return cachedConfig;
    }

    const fromEnv = devFallback();
    if (fromEnv) {
      cachedConfig = fromEnv;
      return cachedConfig;
    }

    throw new Error(
      'Runtime config not found. Either /runtime-config.json must be served (production) ' +
        'or NEXT_PUBLIC_COGNITO_DOMAIN / NEXT_PUBLIC_COGNITO_CLIENT_ID / NEXT_PUBLIC_API_BASE_URL must be set (dev).',
    );
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

/** Test/storybook 用 — キャッシュをリセットする */
export function resetConfigCache(): void {
  cachedConfig = null;
  inflight = null;
}
