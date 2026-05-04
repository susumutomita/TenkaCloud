export interface AppConfig {
  readonly cognitoDomain: string;
  readonly cognitoClientId: string;
  readonly redirectUri: string;
  readonly scope: string;
  /** システム内部用のテナント識別子 (ULID 等)。画面には直接表示しない。 */
  readonly tenantId: string;
  /** 画面表示用のテナント名 (admin-console での tenant 作成時に入力された名前)。 */
  readonly tenantName: string;
  /**
   * テナント API の base URL (末尾スラッシュなし)。#40-d で追加。
   * application-admin-console は /apps 等の操作を JWT 認証付きでここに送る。
   * dev fallback ではダミー URL になるので実 API 呼び出しは成立しない。
   */
  readonly apiBaseUrl: string;
}

/**
 * production では CloudFront 同ドメインの `/runtime-config.json` に URL と
 * テナント情報が書かれている。ApplicationAdminConsoleHosting (TenantTemplateStack 内の
 * Construct) が deployRuntimeConfig() で配置する。
 */
interface RuntimeConfig {
  readonly cognitoDomain: string;
  readonly userClientId: string;
  readonly tenantId: string;
  readonly tenantName: string;
  readonly apiUrl: string;
}

async function fetchRuntimeConfig(): Promise<RuntimeConfig | null> {
  try {
    const res = await fetch("/runtime-config.json", { cache: "no-store" });
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<RuntimeConfig>;
    if (
      !data.cognitoDomain ||
      !data.userClientId ||
      !data.tenantId ||
      !data.tenantName ||
      !data.apiUrl
    )
      return null;
    return {
      cognitoDomain: data.cognitoDomain,
      userClientId: data.userClientId,
      tenantId: data.tenantId,
      tenantName: data.tenantName,
      apiUrl: data.apiUrl,
    };
  } catch {
    return null;
  }
}

/** dev (`make dev`) で `/runtime-config.json` が無い場合の placeholder。production には使わない。 */
const DEV_FALLBACK_TENANT_ID = "dev-local";
const DEV_FALLBACK_TENANT_NAME = "Local Dev Tenant";
const DEV_FALLBACK_API_BASE_URL = "http://localhost:3999";

/**
 * 設定を解決する。URL は以下のいずれかから来る:
 *   1. `/runtime-config.json` (production、CloudFront から配信)
 *   2. `import.meta.env.VITE_*` (dev、apps/application-admin-console/.env.local に書いた値)
 *
 * redirectUri は env に依存しない — 常に `window.location.origin/callback` で解決する。
 *
 * tenantId / tenantName / apiBaseUrl は production では runtime-config.json が必ず持つ。
 * dev fallback では DEV_FALLBACK_* の placeholder を使う (env で上書きしない方針 —
 * 同じ dist が全テナントで共有されるため env に焼くと混乱の元)。
 */
export async function loadConfig(
  env: Record<string, string | undefined> = import.meta.env,
): Promise<AppConfig> {
  const redirectUri = `${window.location.origin}/callback`;
  const scope = env.VITE_COGNITO_SCOPE ?? "openid email profile";

  const runtime = await fetchRuntimeConfig();
  if (runtime) {
    return {
      cognitoDomain: runtime.cognitoDomain,
      cognitoClientId: runtime.userClientId,
      tenantId: runtime.tenantId,
      tenantName: runtime.tenantName,
      apiBaseUrl: runtime.apiUrl,
      redirectUri,
      scope,
    };
  }

  // dev fallback: 認証用 URL は .env.local / import.meta.env から、テナント情報は
  // ハードコード placeholder (dev-local / Local Dev Tenant / http://localhost:3999)。
  const required = (key: string): string => {
    const value = env[key];
    if (!value) throw new Error(`Missing required env var: ${key}`);
    return value;
  };
  return {
    cognitoDomain: required("VITE_COGNITO_DOMAIN"),
    cognitoClientId: required("VITE_COGNITO_CLIENT_ID"),
    tenantId: DEV_FALLBACK_TENANT_ID,
    tenantName: DEV_FALLBACK_TENANT_NAME,
    apiBaseUrl: DEV_FALLBACK_API_BASE_URL,
    redirectUri,
    scope,
  };
}
