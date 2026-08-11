/**
 * [Issue #1411] Concrete GCP STS + IAM Credentials REST client.
 *
 * trust-bridge の `GcpStsClient` (= `GcpWorkloadIdentityFederationExchange` の注入境界) を実 GCP REST API に
 * 実装する。 2 段の token 交換を担う:
 * 1. STS token exchange: subject token (AWS-signed GetCallerIdentity) を WIF pool の
 *      federated access token に交換 (`https://sts.googleapis.com/v1/token`)。
 *   2. service account impersonation: federated token を per-team SA の短命 access token に交換
 *      (`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/{email}:generateAccessToken`)。
 *
 * Sakura / Azure REST client と同方針で `handlers/` の外 (service 層) に置き `fetch` を閉じ込める。
 */

import type {
  GcpStsClient,
  GcpStsExchangeInput,
  GcpStsExchangeOutput,
  GenerateServiceAccountTokenInput,
  GenerateServiceAccountTokenOutput,
} from "@TenkaCloud/trust-bridge";

const DEFAULT_STS_BASE = "https://sts.googleapis.com/v1";
const DEFAULT_IAM_CREDENTIALS_BASE = "https://iamcredentials.googleapis.com/v1";
const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:token-exchange";
const REQUESTED_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";

export interface GcpStsRestClientOptions {
  /** STS base URL override (= test)。 */
  readonly stsBaseUrl?: string;
  /** IAM Credentials base URL override (= test)。 */
  readonly iamCredentialsBaseUrl?: string;
  /** fetch 実装の注入 (= unit test で mock)。 */
  readonly fetchImpl?: typeof fetch;
}

export function createGcpStsRestClient(options: GcpStsRestClientOptions = {}): GcpStsClient {
  const stsBase = (options.stsBaseUrl ?? DEFAULT_STS_BASE).replace(/\/$/, "");
  const iamBase = (options.iamCredentialsBaseUrl ?? DEFAULT_IAM_CREDENTIALS_BASE).replace(
    /\/$/,
    "",
  );
  const doFetch = options.fetchImpl ?? fetch;

  return {
    async exchangeToken(input: GcpStsExchangeInput): Promise<GcpStsExchangeOutput> {
      const res = await doFetch(`${stsBase}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          audience: input.audience,
          grantType: GRANT_TYPE,
          requestedTokenType: REQUESTED_TOKEN_TYPE,
          scope: input.scope,
          subjectToken: input.subjectToken,
          subjectTokenType: input.subjectTokenType,
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`GCP STS token exchange failed: ${res.status} ${text}`.trim());
      }
      const json = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
      if (typeof json.access_token !== "string" || json.access_token.length === 0) {
        throw new Error("GCP STS token exchange response missing access_token");
      }
      return {
        access_token: json.access_token,
        expires_in: typeof json.expires_in === "number" ? json.expires_in : 0,
      };
    },

    async generateServiceAccountToken(
      input: GenerateServiceAccountTokenInput,
    ): Promise<GenerateServiceAccountTokenOutput> {
      const res = await doFetch(
        `${iamBase}/projects/-/serviceAccounts/${encodeURIComponent(input.serviceAccountEmail)}:generateAccessToken`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${input.federatedToken}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            scope: input.scopes,
            lifetime: `${input.lifetimeSeconds}s`,
          }),
        },
      );
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(
          `GCP iamcredentials generateAccessToken failed: ${res.status} ${text}`.trim(),
        );
      }
      const json = (await res.json()) as { accessToken?: unknown; expireTime?: unknown };
      if (typeof json.accessToken !== "string" || json.accessToken.length === 0) {
        throw new Error("GCP generateAccessToken response missing accessToken");
      }
      return {
        accessToken: json.accessToken,
        expireTime: typeof json.expireTime === "string" ? json.expireTime : "",
      };
    },
  };
}
