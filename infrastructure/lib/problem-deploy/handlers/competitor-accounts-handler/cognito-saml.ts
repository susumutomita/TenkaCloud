import {
  type CognitoIdentityProviderClient,
  CreateIdentityProviderCommand,
  DeleteIdentityProviderCommand,
  DescribeIdentityProviderCommand,
  DescribeUserPoolClientCommand,
  UpdateIdentityProviderCommand,
  UpdateUserPoolClientCommand,
} from "@aws-sdk/client-cognito-identity-provider";

/**
 * Issue #839 follow-up Phase B: Tenant 管理者が画面から SAML 設定を変えるための Cognito SDK
 * wrapper。 IdP CRUD + UserPoolClient の SupportedIdentityProviders 書換を pure-ish に保つ。
 *
 * 関数は **idempotent**:
 *   - `upsertSamlProvider`: 既存なら Update、 無ければ Create
 *   - `attachSamlToClient`: SupportedIdentityProviders に追加 (= 既に居れば no-op)
 *   - `detachSamlFromClient`: 削除 (= 居なければ no-op)、 COGNITO は必ず残す
 *   - `enforceSamlOnlyOnClient`: COGNITO を抜き、 ExplicitAuthFlows を SAML 互換に絞る
 *   - `allowCognitoOnClient`: COGNITO を戻す、 ExplicitAuthFlows を SRP / REFRESH_TOKEN へ復元
 *
 * 全関数で `userPoolId` と `userPoolClientId` を引数で受ける (= JWT から runtime 抽出した値を
 * handler 側で渡す)。 wildcard IAM だが runtime guard で self-pool に限定する設計。
 */

export interface CognitoSamlDeps {
  readonly client: Pick<CognitoIdentityProviderClient, "send">;
  readonly userPoolId: string;
  readonly userPoolClientId: string;
}

export interface SamlProviderInput {
  readonly providerName: string;
  readonly metadataUrl: string;
  readonly attributeMapping: Readonly<Record<string, string>>;
}

/**
 * SAML IdP を idempotent に upsert する。 既存なら Update、 無ければ Create。
 * ProviderDetails の MetadataURL が変わったら Cognito 側で metadata XML を re-fetch する。
 */
export async function upsertSamlProvider(
  deps: CognitoSamlDeps,
  input: SamlProviderInput,
): Promise<void> {
  const exists = await describeSamlProvider(deps, input.providerName);
  if (exists) {
    await deps.client.send(
      new UpdateIdentityProviderCommand({
        UserPoolId: deps.userPoolId,
        ProviderName: input.providerName,
        ProviderDetails: {
          MetadataURL: input.metadataUrl,
          IDPSignout: "true",
        },
        AttributeMapping: { ...input.attributeMapping },
      }),
    );
  } else {
    await deps.client.send(
      new CreateIdentityProviderCommand({
        UserPoolId: deps.userPoolId,
        ProviderName: input.providerName,
        ProviderType: "SAML",
        ProviderDetails: {
          MetadataURL: input.metadataUrl,
          IDPSignout: "true",
        },
        AttributeMapping: { ...input.attributeMapping },
      }),
    );
  }
}

async function describeSamlProvider(deps: CognitoSamlDeps, providerName: string): Promise<boolean> {
  try {
    await deps.client.send(
      new DescribeIdentityProviderCommand({
        UserPoolId: deps.userPoolId,
        ProviderName: providerName,
      }),
    );
    return true;
  } catch (err) {
    if ((err as { name?: string })?.name === "ResourceNotFoundException") return false;
    throw err;
  }
}

/**
 * SAML IdP を削除する。 不在なら no-op (= idempotent)。
 */
export async function deleteSamlProvider(
  deps: CognitoSamlDeps,
  providerName: string,
): Promise<void> {
  try {
    await deps.client.send(
      new DeleteIdentityProviderCommand({
        UserPoolId: deps.userPoolId,
        ProviderName: providerName,
      }),
    );
  } catch (err) {
    if ((err as { name?: string })?.name === "ResourceNotFoundException") return;
    throw err;
  }
}

/**
 * UserPoolClient の SupportedIdentityProviders に SAML provider を追加する (= 既に居れば
 * no-op)。 ExplicitAuthFlows は触らない (= COGNITO 経路は維持)。
 */
export async function attachSamlToClient(
  deps: CognitoSamlDeps,
  providerName: string,
): Promise<void> {
  const current = await readClientState(deps);
  if (current.supportedIdentityProviders.includes(providerName)) return;
  await deps.client.send(
    new UpdateUserPoolClientCommand({
      UserPoolId: deps.userPoolId,
      ClientId: deps.userPoolClientId,
      SupportedIdentityProviders: [...current.supportedIdentityProviders, providerName],
      ExplicitAuthFlows: [...current.explicitAuthFlows] as never,
      CallbackURLs: [...current.callbackUrls],
      LogoutURLs: [...current.logoutUrls],
      AllowedOAuthFlows: [...current.allowedOAuthFlows] as (
        | "code"
        | "implicit"
        | "client_credentials"
      )[],
      AllowedOAuthScopes: [...current.allowedOAuthScopes],
      AllowedOAuthFlowsUserPoolClient: current.allowedOAuthFlowsUserPoolClient,
      ReadAttributes: [...current.readAttributes],
      WriteAttributes: [...current.writeAttributes],
    }),
  );
}

/**
 * UserPoolClient の SupportedIdentityProviders から SAML を取り除き、 COGNITO を必ず含むよう
 * 復元する (= SAML 削除時の lock-out 防止)。 ExplicitAuthFlows は SRP + REFRESH_TOKEN を戻す。
 *
 * `ALLOW_USER_PASSWORD_AUTH` は戻さない。 これは username / password をそのまま
 * `InitiateAuth` へ送る Cognito 版の ROPC で、 RFC 9700 (BCP 240) が **MUST NOT** と規定した
 * grant にあたる。 復元の目的は「SAML を外したときに誰も入れなくなるのを防ぐ」ことで、 それは
 * `ALLOW_USER_SRP_AUTH` だけで果たせる — SRP は同じくパスワードで sign-in できるが、 パスワード
 * 自体をサーバへ送らない。 つまり ROPC を戻す必要はもとから無かった。
 *
 * リポジトリ内に `USER_PASSWORD_AUTH` で認証している経路は無い (検索済み)。 有効化していたのは
 * ここだけで、 SAML を外すたびに使われない ROPC が復活していた。
 */
export async function allowCognitoOnClient(
  deps: CognitoSamlDeps,
  providerName: string | undefined,
): Promise<void> {
  const current = await readClientState(deps);
  const filtered = current.supportedIdentityProviders.filter((p) => p !== providerName);
  const next = filtered.includes("COGNITO") ? filtered : ["COGNITO", ...filtered];
  await deps.client.send(
    new UpdateUserPoolClientCommand({
      UserPoolId: deps.userPoolId,
      ClientId: deps.userPoolClientId,
      SupportedIdentityProviders: next,
      ExplicitAuthFlows: ["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
      CallbackURLs: [...current.callbackUrls],
      LogoutURLs: [...current.logoutUrls],
      AllowedOAuthFlows: [...current.allowedOAuthFlows] as (
        | "code"
        | "implicit"
        | "client_credentials"
      )[],
      AllowedOAuthScopes: [...current.allowedOAuthScopes],
      AllowedOAuthFlowsUserPoolClient: current.allowedOAuthFlowsUserPoolClient,
      ReadAttributes: [...current.readAttributes],
      WriteAttributes: [...current.writeAttributes],
    }),
  );
}

/**
 * SAML only に絞る: SupportedIdentityProviders を SAML provider 1 個のみ、 ExplicitAuthFlows を
 * REFRESH_TOKEN のみ (= password / SRP を閉じる) に更新する。 lock-out 防止のため caller (handler)
 * 側で確認を取った前提で呼ぶ。
 */
export async function enforceSamlOnlyOnClient(
  deps: CognitoSamlDeps,
  providerName: string,
): Promise<void> {
  const current = await readClientState(deps);
  await deps.client.send(
    new UpdateUserPoolClientCommand({
      UserPoolId: deps.userPoolId,
      ClientId: deps.userPoolClientId,
      SupportedIdentityProviders: [providerName],
      ExplicitAuthFlows: ["ALLOW_REFRESH_TOKEN_AUTH"],
      CallbackURLs: [...current.callbackUrls],
      LogoutURLs: [...current.logoutUrls],
      AllowedOAuthFlows: [...current.allowedOAuthFlows] as (
        | "code"
        | "implicit"
        | "client_credentials"
      )[],
      AllowedOAuthScopes: [...current.allowedOAuthScopes],
      AllowedOAuthFlowsUserPoolClient: current.allowedOAuthFlowsUserPoolClient,
      ReadAttributes: [...current.readAttributes],
      WriteAttributes: [...current.writeAttributes],
    }),
  );
}

interface ClientState {
  readonly supportedIdentityProviders: readonly string[];
  readonly explicitAuthFlows: readonly string[];
  readonly callbackUrls: readonly string[];
  readonly logoutUrls: readonly string[];
  readonly allowedOAuthFlows: readonly string[];
  readonly allowedOAuthScopes: readonly string[];
  readonly allowedOAuthFlowsUserPoolClient: boolean;
  readonly readAttributes: readonly string[];
  readonly writeAttributes: readonly string[];
}

async function readClientState(deps: CognitoSamlDeps): Promise<ClientState> {
  const out = await deps.client.send(
    new DescribeUserPoolClientCommand({
      UserPoolId: deps.userPoolId,
      ClientId: deps.userPoolClientId,
    }),
  );
  const client = out.UserPoolClient ?? {};
  return {
    supportedIdentityProviders: client.SupportedIdentityProviders ?? ["COGNITO"],
    explicitAuthFlows: client.ExplicitAuthFlows ?? [
      "ALLOW_USER_SRP_AUTH",
      "ALLOW_REFRESH_TOKEN_AUTH",
    ],
    callbackUrls: client.CallbackURLs ?? [],
    logoutUrls: client.LogoutURLs ?? [],
    allowedOAuthFlows: client.AllowedOAuthFlows ?? [],
    allowedOAuthScopes: client.AllowedOAuthScopes ?? [],
    allowedOAuthFlowsUserPoolClient: client.AllowedOAuthFlowsUserPoolClient ?? false,
    readAttributes: client.ReadAttributes ?? [],
    writeAttributes: client.WriteAttributes ?? [],
  };
}

/**
 * JWT `iss` claim から UserPool ID を抽出する pure helper。 Cognito JWT は
 * `https://cognito-idp.<region>.amazonaws.com/<userPoolId>` の形式で iss を発行する。
 *
 * UserPool ID は `<region>_<14 文字英数字>` で、 Cognito の正式な書式。 形式が合わなければ undefined。
 */
export function extractUserPoolIdFromIss(iss: string | undefined): string | undefined {
  if (typeof iss !== "string" || iss.length === 0) return undefined;
  const m = iss.match(/^https:\/\/cognito-idp\.[a-z0-9-]+\.amazonaws\.com\/([a-z0-9_-]+)$/i);
  return m ? m[1] : undefined;
}
