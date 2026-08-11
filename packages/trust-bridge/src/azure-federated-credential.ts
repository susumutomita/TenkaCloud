import {
  type ExchangeContext,
  ExchangeError,
  type ProviderCredential,
  type ProviderTokenExchange,
} from "./provider.js";
import type { VerifiedCloudActionIntent } from "./schema.js";

/**
 * Issue #795: AzureFederatedCredentialExchange adapter (prototype)。
 *
 * Azure の Federated Identity Credential (FIC) は OIDC JWT を Azure AD token
 * exchange に使い、 user-assigned managed identity の access token を取得する
 * 仕組み (= GitHub Actions / Terraform Cloud 等で広く使われる)。
 *
 * TenkaCloud の場合:
 *   1. CloudActionIntent (= JWS) を verify
 *   2. JWS / JWT を `client_assertion` として Azure AD `/oauth2/v2.0/token` に POST
 *      (`grant_type=client_credentials`, `client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer`)
 *   3. 戻ってきた access token を Azure ARM API call に使う
 *
 * `oauth2TokenEndpoint` を呼ぶ HTTP client は inject し、`@azure/identity` を hard dependency
 * にしない。実 Azure subscription の検証は one-time verification として別に行う。
 *
 * provider-subject binding に関する既知の Open Question:
 *   - Azure AD の client_assertion は RFC 7523 JWT を期待する。 本 prototype の
 *     `toClientAssertion` hook は caller に JWT 変換責任を委ねる (= AWS / GCP と
 *     対称な設計)。 trust-bridge 側で JWT claim 変換 utility を提供するかは
 *     Phase 4 末で判断。
 */

export interface AzureCredential extends ProviderCredential {
  readonly provider: "azure";
  readonly accessToken: string;
  readonly tokenType: "Bearer";
  /** managed identity client ID (= app registration object ID)。 */
  readonly clientId: string;
}

/**
 * Azure AD `/oauth2/v2.0/token` を呼ぶ最小抽象。 production では fetch() を wrap、
 * test では fake を渡す。
 */
export interface AzureTokenEndpointClient {
  exchangeAssertion(input: AzureTokenExchangeInput): Promise<AzureTokenExchangeOutput>;
}

export interface AzureTokenExchangeInput {
  readonly tenantId: string;
  readonly clientId: string;
  readonly clientAssertion: string;
  readonly scope: string;
}

export interface AzureTokenExchangeOutput {
  readonly access_token: string;
  readonly token_type: "Bearer";
  readonly expires_in: number;
}

export interface AzureExchangeContext extends ExchangeContext {
  /** Azure AD tenant GUID (= directory ID)。 */
  readonly azureTenantId: string;
  /** managed identity の app registration client ID。 */
  readonly clientId: string;
  /** 取得 access token の scope (例: `https://management.azure.com/.default`)。 */
  readonly scope: string;
}

export interface AzureAdapterOptions {
  readonly tokenClient: AzureTokenEndpointClient;
  readonly now?: () => Date;
  /**
   * Phase 4: intent → JWT (RFC 7523) 変換は caller 責任。 trust-bridge 内で
   * JWT claim を組み立てるための utility を提供するかは Phase 4 末で判断。
   */
  readonly toClientAssertion: (intent: VerifiedCloudActionIntent) => string;
}

export class AzureFederatedCredentialExchange implements ProviderTokenExchange<AzureCredential> {
  readonly provider = "azure" as const;
  private readonly tokenClient: AzureTokenEndpointClient;
  private readonly now: () => Date;
  private readonly toClientAssertion: (intent: VerifiedCloudActionIntent) => string;

  constructor(options: AzureAdapterOptions) {
    this.tokenClient = options.tokenClient;
    this.now = options.now ?? (() => new Date());
    this.toClientAssertion = options.toClientAssertion;
  }

  async exchange(
    intent: VerifiedCloudActionIntent,
    context: ExchangeContext,
  ): Promise<AzureCredential> {
    if (intent.target.provider !== "azure") {
      throw new ExchangeError(
        "provider-mismatch",
        `intent target provider is ${intent.target.provider}, not azure`,
      );
    }

    const azureContext = context as AzureExchangeContext;
    if (!azureContext.azureTenantId || azureContext.azureTenantId.length === 0) {
      throw new ExchangeError("context-missing", "AzureExchangeContext.azureTenantId is required");
    }
    if (!azureContext.clientId || azureContext.clientId.length === 0) {
      throw new ExchangeError("context-missing", "AzureExchangeContext.clientId is required");
    }
    if (!azureContext.scope || azureContext.scope.length === 0) {
      throw new ExchangeError("context-missing", "AzureExchangeContext.scope is required");
    }

    const assertion = this.toClientAssertion(intent);
    const issuedAt = this.now();

    let output: AzureTokenExchangeOutput;
    try {
      output = await this.tokenClient.exchangeAssertion({
        tenantId: azureContext.azureTenantId,
        clientId: azureContext.clientId,
        clientAssertion: assertion,
        scope: azureContext.scope,
      });
    } catch (err) {
      throw new ExchangeError(
        "provider-api-error",
        "Azure AD oauth2/v2.0/token exchange failed",
        err,
      );
    }

    // Azure AD は `expires_in` (= seconds) を返す。 ISO datetime に正規化する。
    const expiresAt = new Date(issuedAt.getTime() + output.expires_in * 1000).toISOString();

    return {
      provider: "azure",
      accessToken: output.access_token,
      tokenType: output.token_type,
      clientId: azureContext.clientId,
      issuedAt: issuedAt.toISOString(),
      expiresAt,
      forRequestId: intent.requestId,
    };
  }
}
