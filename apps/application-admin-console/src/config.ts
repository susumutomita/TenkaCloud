import { isCognitoDomain, isHttpsUrl } from "@tenkacloud/auth-client";
import { resolveFeatureFlags } from "@tenkacloud/web-kit";
import { type AppFeatures, FEATURE_REGISTRY } from "./features";

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
   * JWT 認証付きでここに送る。Issue #458 以降、Deploy 用の独立 base URL は廃止。
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
  /**
   * Issue #897: テナント isolation mode。 "pooled" は UserPool 共有なので SAML SSO のような
   * UserPool mutate 機能は提供しない。 "silo" (= PLATINUM) のみ有効化する。
   * 未注入 / undefined は安全側に倒して "pooled" 扱い (= SAML SSO 隠す)。
   */
  readonly isolation?: "pooled" | "silo";
  /**
   * Issue #1340 Phase 2: per-tenant SAML HRD directory (= email ドメイン → 接続済み SAML
   * provider 名)。 Login 画面が email から候補 IdP を解決して `identity_provider=` を組み立てる。
   * SAML 未設定なら空 object `{}` (= 全 email が Cognito local auth に流れる、 既存挙動互換)。
   * tenant A の Login 画面は自分の CloudFront に置かれた runtime-config.json しか読まないため、
   * 物理的に tenant B の directory は見えない (= isolation は infra layer で担保)。
   */
  readonly samlIdpDirectory: Readonly<Record<string, readonly string[]>>;
  /**
   * Resolved feature flags. The registry (src/features.ts) holds defaults; an environment
   * opts a flag on via runtime-config.json `features: { <key>: true }`. Access as
   * `config.features?.<key>` — unknown keys are a compile error. loadConfig always populates it;
   * optional only so test fixtures can omit it (absent → every flag reads OFF, fail-safe).
   */
  readonly features?: AppFeatures;
  /**
   * Issue #1954: `"demo"` は no-AWS demo mode (`?demo=1` / `VITE_DEMO_MODE=1` で有効化)。
   * このとき useApiClient は fixture client に切り替わり、 AuthProvider は mock session を
   * 注入する (= 実 AWS / Cognito を一切叩かない)。 未設定 (undefined) は通常運用。
   */
  readonly mode?: "demo";
}

interface RuntimeConfig {
  readonly cognitoDomain: string;
  readonly userClientId: string;
  readonly tenantId: string;
  readonly tenantName: string;
  readonly apiUrl: string;
  readonly participantPortalUrl?: string;
  readonly competitorBootstrapTemplateUrl?: string;
  readonly isolation?: "pooled" | "silo";
  readonly samlIdpDirectory?: Readonly<Record<string, readonly string[]>>;
  /** Raw `features` override object from runtime-config.json; resolved against the registry in loadConfig. */
  readonly features?: Readonly<Record<string, unknown>>;
}

// Issue #871 / #1246: runtime-config.json URL validators (isHttpsUrl / isCognitoDomain) are
// imported from @tenkacloud/auth-client to keep the allowlist identical across admin SPAs.

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
      isolation: data.isolation === "silo" ? "silo" : "pooled",
      // Issue #1340 Phase 2: SAML 未設定 stack も無音で動かすため空 object fallback。
      samlIdpDirectory:
        data.samlIdpDirectory && typeof data.samlIdpDirectory === "object"
          ? data.samlIdpDirectory
          : {},
      // Raw feature overrides; resolved against the registry in loadConfig.
      features:
        data.features && typeof data.features === "object" && !Array.isArray(data.features)
          ? data.features
          : undefined,
    };
  } catch {
    return null;
  }
}

const DEV_FALLBACK_TENANT_ID = "dev-local";
const DEV_FALLBACK_TENANT_NAME = "Local Dev Tenant";
const DEV_FALLBACK_API_BASE_URL = "http://localhost:3999";

/**
 * Issue #1954: demo mode は build-time flag (`VITE_DEMO_MODE=1`) / URL の `?demo=1`
 * (LP の「触ってみる」導線) / `/admin-demo/` パス配信 のいずれかで有効化する。
 *
 * パス判定を足したのは、フラグ焼き忘れや `?demo=1` の無い deep link (例: `/admin-demo/login`)
 * でも確実に demo に入れるため。無いと実 Cognito 経路に落ち、空 `cognitoDomain` で
 * `new URL()` が "Invalid URL" を投げる。 本番はドメイン直下配信 (`/admin-demo/` を含まない)
 * なので誤検知しない。
 */
export function isDemoMode(env: Record<string, string | undefined>): boolean {
  if (env.VITE_DEMO_MODE === "1") return true;
  // loadConfig already assumes a browser (window.location.origin below); no SSR guard needed.
  if (new URLSearchParams(window.location.search).get("demo") === "1") return true;
  return window.location.pathname.includes("/admin-demo/");
}

/**
 * Issue #1954: demo 用の AppConfig。 実 Cognito / API を持たないので runtime-config / env を
 * 読まず固定値を返す (apiBaseUrl は到達不能なダミー = 誤って実呼び出ししても外部に出ない)。
 */
function buildDemoConfig(
  redirectUri: string,
  scope: string,
  env: Record<string, string | undefined>,
): AppConfig {
  return {
    cognitoDomain: "demo.auth.tenkacloud.example",
    cognitoClientId: "demo-client",
    tenantId: "demo-tenant",
    tenantName: "Demo Tenant",
    apiBaseUrl: "https://demo.invalid",
    isolation: "pooled",
    samlIdpDirectory: {},
    features: resolveFeatureFlags(FEATURE_REGISTRY, undefined),
    redirectUri,
    scope,
    mode: "demo",
    // 参加者 demo (participant-portal) への hand-off 先。 per-team の招待リンク
    // (EventTeamsPanel) とバナーの「参加者として見る」導線が使う。 ホスティング時は
    // VITE_DEMO_PARTICIPANT_URL で上書き、 既定は participant-portal の `/portal-demo/`。
    participantPortalUrl: env.VITE_DEMO_PARTICIPANT_URL ?? "/portal-demo",
  };
}

export async function loadConfig(
  env: Record<string, string | undefined> = import.meta.env,
): Promise<AppConfig> {
  const redirectUri = `${window.location.origin}/callback`;
  const scope = env.VITE_COGNITO_SCOPE ?? "openid email profile";

  if (isDemoMode(env)) {
    return buildDemoConfig(redirectUri, scope, env);
  }

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
      // fetchRuntimeConfig は isolation / samlIdpDirectory を常に populate する (= line 101 /
      // 103-106) ため、 ここの `??` fallback は到達不能。 値の解決自体は fetchRuntimeConfig 側の
      // テストで担保済。
      /* v8 ignore start */
      isolation: runtime.isolation ?? "pooled",
      samlIdpDirectory: runtime.samlIdpDirectory ?? {},
      /* v8 ignore stop */
      features: resolveFeatureFlags(FEATURE_REGISTRY, runtime.features),
      redirectUri,
      scope,
    };
  }

  const required = (key: string): string => {
    const value = env[key];
    if (!value) throw new Error(`Missing required env var: ${key}`);
    return value;
  };
  /** Dev-only: parse VITE_FEATURES (a JSON object of overrides); invalid / absent → registry defaults. */
  const parseDevFeatures = (raw: string | undefined): Record<string, unknown> | undefined => {
    if (!raw) return undefined;
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  };
  return {
    cognitoDomain: required("VITE_COGNITO_DOMAIN"),
    cognitoClientId: required("VITE_COGNITO_CLIENT_ID"),
    tenantId: DEV_FALLBACK_TENANT_ID,
    tenantName: DEV_FALLBACK_TENANT_NAME,
    apiBaseUrl: env.VITE_API_BASE_URL ?? DEV_FALLBACK_API_BASE_URL,
    isolation: env.VITE_ISOLATION === "silo" ? "silo" : "pooled",
    // Issue #1340 Phase 2: dev では SAML 経路を出さない (= 空 directory で local 一択)。
    samlIdpDirectory: {},
    // Dev: opt features in with VITE_FEATURES='{"samlSso":true}'; absent → registry defaults (OFF).
    features: resolveFeatureFlags(FEATURE_REGISTRY, parseDevFeatures(env.VITE_FEATURES)),
    redirectUri,
    scope,
  };
}
