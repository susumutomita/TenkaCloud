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
   * テナント API の base URL (末尾スラッシュなし)。
   * application-admin-console は全 API 呼び出し (テナント管理 + Deploy 系) を
   * JWT 認証付きでここに送る。Issue #458 / ADR-001 以降、Deploy 用の独立 base URL は廃止。
   * dev fallback ではダミー URL になるので実 API 呼び出しは成立しない。
   */
  readonly apiBaseUrl: string;
  /**
   * 競技者向け Participant Portal の URL。EventDetail / DeploymentDetail から
   * operator が「このイベントの portal を共有」する画面表示に使う。
   * runtime-config に未注入なら undefined (CDK 側 wire-up が完了するまで fallback 表示)。
   */
  readonly participantPortalUrl?: string;
  /**
   * #718: 競技者向け CFn bootstrap template (competitor-bootstrap.yaml) の public S3 URL。
   * CFn `TemplateURL` は S3 URL のみ受け付けるので Launch Stack / Update Stack deeplink に
   * 渡す URL は S3 でなければならない。未注入 (= Phase 3 redeploy 前) は GitHub raw URL に
   * fallback する (= dev / 初回 deploy 用、 deeplink としては不正だが手 download 可能)。
   */
  readonly competitorBootstrapTemplateUrl?: string;
}

interface RuntimeConfig {
  readonly cognitoDomain: string;
  readonly userClientId: string;
  readonly tenantId: string;
  readonly tenantName: string;
  readonly apiUrl: string;
  readonly participantPortalUrl?: string;
  readonly competitorBootstrapTemplateUrl?: string;
}

/**
 * Issue #871: runtime-config.json の URL validate (= S3 / CloudFront tampering 対策)。
 *   - apiUrl: \`https://\` 必須
 *   - cognitoDomain: \`https://\` 必須 + \`.amazoncognito.com\` 終端 (allowlist)
 *
 * 検証失敗時は null → caller が env fallback に倒れる (= production では env が空で throw)。
 */
function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function isCognitoDomain(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && u.host.endsWith(".amazoncognito.com");
  } catch {
    return false;
  }
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
    // Issue #871: protocol / host を validate (= tampering 対策)
    if (!isHttpsUrl(data.apiUrl)) {
      console.error("[config] runtime-config.json apiUrl is not HTTPS, rejecting", {
        apiUrl: data.apiUrl,
      });
      return null;
    }
    if (!isCognitoDomain(data.cognitoDomain)) {
      console.error("[config] runtime-config.json cognitoDomain failed allowlist, rejecting", {
        cognitoDomain: data.cognitoDomain,
      });
      return null;
    }
    return {
      cognitoDomain: data.cognitoDomain,
      userClientId: data.userClientId,
      tenantId: data.tenantId,
      tenantName: data.tenantName,
      apiUrl: data.apiUrl,
      participantPortalUrl:
        typeof data.participantPortalUrl === "string" ? data.participantPortalUrl : undefined,
      competitorBootstrapTemplateUrl:
        typeof data.competitorBootstrapTemplateUrl === "string"
          ? data.competitorBootstrapTemplateUrl
          : undefined,
    };
  } catch {
    return null;
  }
}

const DEV_FALLBACK_TENANT_ID = "dev-local";
const DEV_FALLBACK_TENANT_NAME = "Local Dev Tenant";
const DEV_FALLBACK_API_BASE_URL = "http://localhost:3999";

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
      participantPortalUrl: runtime.participantPortalUrl,
      competitorBootstrapTemplateUrl: runtime.competitorBootstrapTemplateUrl,
      redirectUri,
      scope,
    };
  }

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
    apiBaseUrl: env.VITE_API_BASE_URL ?? DEV_FALLBACK_API_BASE_URL,
    redirectUri,
    scope,
  };
}
