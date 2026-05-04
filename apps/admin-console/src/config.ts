export interface AppConfig {
  readonly cognitoDomain: string;
  readonly cognitoClientId: string;
  readonly redirectUri: string;
  readonly apiBaseUrl: string;
  readonly scope: string;
  /**
   * Pooled tier tenants が共有する application-admin-console の CloudFront URL。
   * TenantList で basic / advanced tenant の「Application Console を開く」リンクに使う。
   * production では runtime-config.json 経由、dev fallback では空文字 (未設定)。
   */
  readonly pooledApplicationAdminConsoleUrl: string;
  /**
   * Provisioning ジョブを動かす SBT BashJobRunner の CodeBuild project 名。
   * AWS Console CodeBuild build deep link の構築に使う。"unknown" のとき
   * admin-console は「ログ」リンクを出さない。
   */
  readonly provisioningCodeBuildProject: string;
  /** AWS region (例: ap-northeast-1)。CodeBuild console URL の {region} に埋める。 */
  readonly awsRegion: string;
  /** AWS account ID。CodeBuild console URL の {accountId} に埋める。 */
  readonly awsAccountId: string;
}

/**
 * production では CloudFront 同ドメインの `/runtime-config.json` に URL が書かれている。
 * AdminConsoleHostingStack が CDK deploy 時に配置する。
 */
interface RuntimeConfig {
  readonly apiUrl: string;
  readonly cognitoDomain: string;
  readonly userClientId: string;
  readonly pooledApplicationAdminConsoleUrl?: string;
  readonly provisioningCodeBuildProject?: string;
  readonly awsRegion?: string;
  readonly awsAccountId?: string;
}

async function fetchRuntimeConfig(): Promise<RuntimeConfig | null> {
  try {
    const res = await fetch("/runtime-config.json", { cache: "no-store" });
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<RuntimeConfig>;
    if (!data.apiUrl || !data.cognitoDomain || !data.userClientId) return null;
    return {
      apiUrl: data.apiUrl,
      cognitoDomain: data.cognitoDomain,
      userClientId: data.userClientId,
      pooledApplicationAdminConsoleUrl: data.pooledApplicationAdminConsoleUrl,
      provisioningCodeBuildProject: data.provisioningCodeBuildProject,
      awsRegion: data.awsRegion,
      awsAccountId: data.awsAccountId,
    };
  } catch {
    return null;
  }
}

/**
 * 設定を解決する。URL は以下のいずれかから来る:
 *   1. `/runtime-config.json` (production、CloudFront から配信)
 *   2. `import.meta.env.VITE_*` (dev、apps/admin-console/.env.local に書いた値)
 *
 * redirectUri は env に依存しない — 常に `window.location.origin/callback` で解決する。
 *
 * pooledApplicationAdminConsoleUrl / provisioningCodeBuildProject / awsRegion /
 * awsAccountId は #57 で追加。runtime-config.json に無ければ空文字 fallback で、
 * UI 側で「未発行」「リンク無効化」表示にする。dev fallback は明示的に渡さない
 * (env で固定すると同じ dist が複数 deployment で共有される production 思想と矛盾)。
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
      apiBaseUrl: runtime.apiUrl,
      redirectUri,
      scope,
      pooledApplicationAdminConsoleUrl: runtime.pooledApplicationAdminConsoleUrl ?? "",
      provisioningCodeBuildProject: runtime.provisioningCodeBuildProject ?? "unknown",
      awsRegion: runtime.awsRegion ?? "",
      awsAccountId: runtime.awsAccountId ?? "",
    };
  }

  // dev fallback: .env.local / import.meta.env から
  const required = (key: string): string => {
    const value = env[key];
    if (!value) throw new Error(`Missing required env var: ${key}`);
    return value;
  };
  return {
    cognitoDomain: required("VITE_COGNITO_DOMAIN"),
    cognitoClientId: required("VITE_COGNITO_CLIENT_ID"),
    apiBaseUrl: required("VITE_API_BASE_URL"),
    redirectUri,
    scope,
    // dev では admin-console から pooled console / 実 CodeBuild へのリンクは出ない
    pooledApplicationAdminConsoleUrl: "",
    provisioningCodeBuildProject: "unknown",
    awsRegion: "",
    awsAccountId: "",
  };
}
