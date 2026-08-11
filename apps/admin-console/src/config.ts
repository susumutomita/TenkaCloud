import { isCognitoDomain, isHttpsUrl } from "@tenkacloud/auth-client";
import { resolveFeatureFlags } from "@tenkacloud/web-kit";
import { type AppFeatures, FEATURE_REGISTRY } from "./features";

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
  /**
   * Admin Insight API のエンドポイント (Issue #590)。tenant 一覧の
   * deploy 集計 column (activeDeploys / failedDeploys) を取得するのに使う。
   * 空文字なら admin-console は集計 fetch をスキップする (= phase 2 初回 deploy の race 対策)。
   */
  readonly adminInsightApiUrl: string;
  /**
   * Issue #1080: ObservabilityStack の CloudWatch Dashboard 名。 Operations page で
   * AWS Console deep link を組み立てる。 空文字なら link を出さない (= dev fallback)。
   */
  readonly cloudWatchDashboardName: string;
  /**
   * Issue #1335 Phase 1: SAML HRD directory (= email ドメイン → 接続済み SAML provider 名)。
   * Login 画面が email から候補 IdP を解決して `identity_provider` を組み立てる。
   * SAML 未設定なら空 object `{}` (= 全 email が Cognito local auth に流れる)。
   */
  readonly samlIdpDirectory: Readonly<Record<string, readonly string[]>>;
  /**
   * Resolved feature flags. Registry in src/features.ts; an environment opts a flag on
   * via runtime-config.json `features: { <key>: true }`. Access as `config.features?.<key>`.
   * loadConfig always populates it; optional only so test fixtures can omit it (absent → all OFF).
   */
  readonly features?: AppFeatures;
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
  readonly adminInsightApiUrl?: string;
  readonly cloudWatchDashboardName?: string;
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
    if (!data.apiUrl || !data.cognitoDomain || !data.userClientId) return null;
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
      apiUrl: data.apiUrl,
      cognitoDomain: data.cognitoDomain,
      userClientId: data.userClientId,
      pooledApplicationAdminConsoleUrl: data.pooledApplicationAdminConsoleUrl,
      provisioningCodeBuildProject: data.provisioningCodeBuildProject,
      awsRegion: data.awsRegion,
      awsAccountId: data.awsAccountId,
      adminInsightApiUrl: data.adminInsightApiUrl,
      cloudWatchDashboardName: data.cloudWatchDashboardName,
      samlIdpDirectory: data.samlIdpDirectory,
      features:
        data.features && typeof data.features === "object" && !Array.isArray(data.features)
          ? data.features
          : undefined,
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
      adminInsightApiUrl: runtime.adminInsightApiUrl ?? "",
      cloudWatchDashboardName: runtime.cloudWatchDashboardName ?? "",
      // Issue #1335 Phase 1: SAML 未設定 stack も無音で動かすため空 object fallback。
      samlIdpDirectory: runtime.samlIdpDirectory ?? {},
      features: resolveFeatureFlags(FEATURE_REGISTRY, runtime.features),
    };
  }

  // dev fallback: .env.local / import.meta.env から
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
    apiBaseUrl: required("VITE_API_BASE_URL"),
    redirectUri,
    scope,
    // dev では admin-console から pooled console / 実 CodeBuild へのリンクは出ない
    pooledApplicationAdminConsoleUrl: "",
    provisioningCodeBuildProject: "unknown",
    awsRegion: "",
    awsAccountId: "",
    // Issue #590: dev では admin-insight API も未配線 (= 集計 column を skip)
    adminInsightApiUrl: env.VITE_ADMIN_INSIGHT_API_URL ?? "",
    // #1080: dev fallback では CloudWatch Dashboard リンクを出さない
    cloudWatchDashboardName: "",
    // Issue #1335 Phase 1: dev では SAML 経路を出さない (= 空 directory で local 一択)。
    samlIdpDirectory: {},
    // Unverified features default OFF; opt in with VITE_FEATURES='{"samlSso":true}'.
    features: resolveFeatureFlags(FEATURE_REGISTRY, parseDevFeatures(env.VITE_FEATURES)),
  };
}
