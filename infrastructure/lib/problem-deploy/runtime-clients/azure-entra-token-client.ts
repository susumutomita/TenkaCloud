/**
 * [Issue #1410] Microsoft Entra ID `client_credentials` token client.
 *
 * 決定どおり、 Azure deploy は per-team app registration の client secret で
 * `client_credentials` grant を行い ARM access token を得る (= WIF/OIDC issuer は将来アップグレード)。
 * Sakura / ARM REST client と同方針で `handlers/` の外 (service 層) に置き `fetch` を閉じ込める。
 *
 * endpoint: `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token`
 *   body (application/x-www-form-urlencoded): grant_type=client_credentials, client_id, client_secret, scope
 *   response: `{access_token, token_type, expires_in}`
 */

const DEFAULT_AUTHORITY = "https://login.microsoftonline.com";
/** ARM 操作のための既定 scope。 */
export const ARM_DEFAULT_SCOPE = "https://management.azure.com/.default";

export interface AzureEntraTokenInput {
  readonly azureTenantId: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** OAuth2 scope。 省略時 ARM の `.default`。 */
  readonly scope?: string;
}

export interface AzureEntraTokenClient {
  /** client_credentials grant で access token (文字列) を得る。 */
  getToken(input: AzureEntraTokenInput): Promise<string>;
}

export interface AzureEntraTokenClientOptions {
  /** authority base URL override (= test / sovereign cloud)。 省略時 login.microsoftonline.com。 */
  readonly authority?: string;
  /** fetch 実装の注入 (= unit test で mock)。 */
  readonly fetchImpl?: typeof fetch;
}

export function createAzureEntraTokenClient(
  options: AzureEntraTokenClientOptions = {},
): AzureEntraTokenClient {
  const authority = (options.authority ?? DEFAULT_AUTHORITY).replace(/\/$/, "");
  const doFetch = options.fetchImpl ?? fetch;

  return {
    async getToken(input: AzureEntraTokenInput): Promise<string> {
      const body = new URLSearchParams({
        grant_type: "client_credentials",
        client_id: input.clientId,
        client_secret: input.clientSecret,
        scope: input.scope ?? ARM_DEFAULT_SCOPE,
      });
      const res = await doFetch(`${authority}/${input.azureTenantId}/oauth2/v2.0/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: body.toString(),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Entra ID client_credentials token failed: ${res.status} ${text}`.trim());
      }
      const json = (await res.json()) as { access_token?: unknown };
      if (typeof json.access_token !== "string" || json.access_token.length === 0) {
        throw new Error("Entra ID token response missing access_token");
      }
      return json.access_token;
    },
  };
}
