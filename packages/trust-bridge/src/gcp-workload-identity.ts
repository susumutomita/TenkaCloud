import {
  type ExchangeContext,
  ExchangeError,
  type ProviderCredential,
  type ProviderTokenExchange,
} from "./provider.js";
import type { VerifiedCloudActionIntent } from "./schema.js";

/**
 * Issue #795: GcpWorkloadIdentityFederationExchange adapter (prototype)。
 *
 * Google Cloud の Workload Identity Federation (WIF) は OIDC / SAML token を
 * GCP service account の short-lived access token に交換する仕組み。 TenkaCloud
 * の場合は次の 3 段:
 *
 *   1. CloudActionIntent (= JWS, HS256) を verify
 *   2. JWS を re-sign せず、 そのまま GCP STS の `audience` field に乗せる形で
 *      WIF pool に submit (= GCP STS API)
 *   3. 戻ってきた federated token を `iamcredentials.googleapis.com` の
 *      `generateAccessToken` API で service account の OAuth2 access token に
 *      exchange
 *
 * (2) と (3) を呼ぶ HTTP client は inject し、@google-cloud 系 SDK を hard dependency にしない。
 * 実 GCP account の検証は one-time verification として別に行う。
 *
 * provider-subject binding に関する既知の Open Question:
 *   - CloudActionIntent を JWT として直接 GCP STS に渡すべきか、 JWS で包んだ
 *     canonical JSON を audience に乗せるか。 GCP STS は JWT を期待するため、
 *     Phase 4 末で intent → JWT claim 変換 layer を追加するか、 JWS のまま
 *     allowAudiences として WIF pool に登録するかを決める。 本 prototype は
 *     後者 (= JWS そのまま) を想定した interface 形。
 */

export interface GcpCredential extends ProviderCredential {
  readonly provider: "gcp";
  readonly accessToken: string;
  readonly serviceAccountEmail: string;
  /** GCP STS から受け取った federated token (= service account の generateAccessToken に渡す中間 token)。 */
  readonly federatedToken: string;
}

/**
 * GCP STS API + iamcredentials API を呼ぶ最小抽象。 production では
 * `@google-cloud/iam-credentials` を wrap、 test では fake を渡す。
 */
export interface GcpStsClient {
  /**
   * GCP STS `https://sts.googleapis.com/v1/token` 相当。 OIDC token (= 本 adapter
   * では trust-bridge の JWS) を federated token に交換する。
   */
  exchangeToken(input: GcpStsExchangeInput): Promise<GcpStsExchangeOutput>;
  /**
   * IAM Credentials API `iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/{email}:generateAccessToken`。
   * federated token を service account の OAuth2 access token に交換する。
   */
  generateServiceAccountToken(
    input: GenerateServiceAccountTokenInput,
  ): Promise<GenerateServiceAccountTokenOutput>;
}

export interface GcpStsExchangeInput {
  readonly audience: string;
  readonly subjectToken: string;
  readonly subjectTokenType: string;
  readonly scope: string;
}

export interface GcpStsExchangeOutput {
  readonly access_token: string;
  readonly expires_in: number;
}

export interface GenerateServiceAccountTokenInput {
  readonly serviceAccountEmail: string;
  readonly federatedToken: string;
  readonly lifetimeSeconds: number;
  readonly scopes: readonly string[];
}

export interface GenerateServiceAccountTokenOutput {
  readonly accessToken: string;
  readonly expireTime: string;
}

export interface GcpExchangeContext extends ExchangeContext {
  /** WIF pool の audience URL (例: `//iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/tenkacloud/providers/cdk`)。 */
  readonly wifAudience: string;
  /** federated token を再 exchange する対象 service account email。 */
  readonly serviceAccountEmail: string;
  /** 取得 access token に付与する OAuth2 scopes (例: `["https://www.googleapis.com/auth/cloud-platform"]`)。 */
  readonly oauthScopes: readonly string[];
  /** subject token format。 default `urn:ietf:params:oauth:token-type:jwt`。 */
  readonly subjectTokenType?: string;
}

export interface GcpAdapterOptions {
  readonly stsClient: GcpStsClient;
  readonly now?: () => Date;
  /**
   * Phase 4: caller が intent → JWS token を再構成する責任を持つ (= verify 経路で
   * decode した intent から token 本体を保てない場合があるため)。 sign 関数を
   * inject することで、 caller の鍵で sign し直す経路にも、 元 token を保持して
   * pass-through する経路にも、 どちらも対応する。
   */
  readonly toSubjectToken: (intent: VerifiedCloudActionIntent) => string;
}

export class GcpWorkloadIdentityFederationExchange implements ProviderTokenExchange<GcpCredential> {
  readonly provider = "gcp" as const;
  private readonly stsClient: GcpStsClient;
  private readonly now: () => Date;
  private readonly toSubjectToken: (intent: VerifiedCloudActionIntent) => string;

  constructor(options: GcpAdapterOptions) {
    this.stsClient = options.stsClient;
    this.now = options.now ?? (() => new Date());
    this.toSubjectToken = options.toSubjectToken;
  }

  async exchange(
    intent: VerifiedCloudActionIntent,
    context: ExchangeContext,
  ): Promise<GcpCredential> {
    if (intent.target.provider !== "gcp") {
      throw new ExchangeError(
        "provider-mismatch",
        `intent target provider is ${intent.target.provider}, not gcp`,
      );
    }

    const gcpContext = context as GcpExchangeContext;
    if (!gcpContext.wifAudience || gcpContext.wifAudience.length === 0) {
      throw new ExchangeError("context-missing", "GcpExchangeContext.wifAudience is required");
    }
    if (!gcpContext.serviceAccountEmail || gcpContext.serviceAccountEmail.length === 0) {
      throw new ExchangeError(
        "context-missing",
        "GcpExchangeContext.serviceAccountEmail is required",
      );
    }
    if (!gcpContext.oauthScopes || gcpContext.oauthScopes.length === 0) {
      throw new ExchangeError(
        "context-missing",
        "GcpExchangeContext.oauthScopes must contain at least 1 scope",
      );
    }

    // GCP STS は token lifetime を直接受け取らない (= WIF pool 側で固定)。 intent
    // の ttlSeconds は次段 generateAccessToken の lifetime に転写する。
    const lifetimeSeconds = intent.constraints.ttlSeconds;

    const subjectToken = this.toSubjectToken(intent);
    const issuedAt = this.now();

    let federatedOut: GcpStsExchangeOutput;
    try {
      federatedOut = await this.stsClient.exchangeToken({
        audience: gcpContext.wifAudience,
        subjectToken,
        subjectTokenType: gcpContext.subjectTokenType ?? "urn:ietf:params:oauth:token-type:jwt",
        scope: gcpContext.oauthScopes.join(" "),
      });
    } catch (err) {
      throw new ExchangeError("provider-api-error", "GCP STS exchangeToken failed", err);
    }

    let saOut: GenerateServiceAccountTokenOutput;
    try {
      saOut = await this.stsClient.generateServiceAccountToken({
        serviceAccountEmail: gcpContext.serviceAccountEmail,
        federatedToken: federatedOut.access_token,
        lifetimeSeconds,
        scopes: gcpContext.oauthScopes,
      });
    } catch (err) {
      throw new ExchangeError(
        "provider-api-error",
        "GCP iamcredentials.generateServiceAccountToken failed",
        err,
      );
    }

    return {
      provider: "gcp",
      accessToken: saOut.accessToken,
      serviceAccountEmail: gcpContext.serviceAccountEmail,
      federatedToken: federatedOut.access_token,
      issuedAt: issuedAt.toISOString(),
      expiresAt: saOut.expireTime,
      forRequestId: intent.requestId,
    };
  }
}
