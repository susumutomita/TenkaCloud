/**
 * Cognito UserPool / UserPoolClient / Identity Provider 操作。
 *
 * 重要: UpdateUserPoolClient は渡したフィールドで **全体を上書き** する仕様。
 * CallbackURLs / LogoutURLs だけ渡すと AllowedOAuthFlows / ExplicitAuthFlows /
 * AllowedOAuthScopes 等の OAuth 関連設定がリセットされ Cognito login が動かなくなる。
 * DescribeUserPoolClient から取得した既存値を pass-through してから差分だけ
 * 上書きする必要がある (`mergeIntoExistingUserPoolClient`)。
 */

const {
  CreateIdentityProviderCommand,
  DescribeUserPoolClientCommand,
  DescribeIdentityProviderCommand,
  UpdateIdentityProviderCommand,
  UpdateUserPoolClientCommand,
} = require("@aws-sdk/client-cognito-identity-provider");

function mergeIntoExistingUserPoolClient(userPoolId, clientId, existing, patch) {
  return {
    UserPoolId: userPoolId,
    ClientId: clientId,
    // 既存値を pass-through (未指定だと default にリセットされる)
    ClientName: existing.ClientName,
    RefreshTokenValidity: existing.RefreshTokenValidity,
    AccessTokenValidity: existing.AccessTokenValidity,
    IdTokenValidity: existing.IdTokenValidity,
    TokenValidityUnits: existing.TokenValidityUnits,
    ReadAttributes: existing.ReadAttributes,
    WriteAttributes: existing.WriteAttributes,
    ExplicitAuthFlows: existing.ExplicitAuthFlows,
    SupportedIdentityProviders: existing.SupportedIdentityProviders,
    AllowedOAuthFlows: existing.AllowedOAuthFlows,
    AllowedOAuthScopes: existing.AllowedOAuthScopes,
    AllowedOAuthFlowsUserPoolClient: existing.AllowedOAuthFlowsUserPoolClient,
    AnalyticsConfiguration: existing.AnalyticsConfiguration,
    PreventUserExistenceErrors: existing.PreventUserExistenceErrors,
    EnableTokenRevocation: existing.EnableTokenRevocation,
    EnablePropagateAdditionalUserContextData: existing.EnablePropagateAdditionalUserContextData,
    AuthSessionValidity: existing.AuthSessionValidity,
    DefaultRedirectURI: existing.DefaultRedirectURI,
    CallbackURLs: existing.CallbackURLs,
    LogoutURLs: existing.LogoutURLs,
    // patch で上書き
    ...patch,
  };
}

async function describeUserPoolClient(cognito, userPoolId, clientId) {
  const describe = await cognito.send(
    new DescribeUserPoolClientCommand({ UserPoolId: userPoolId, ClientId: clientId }),
  );
  return describe.UserPoolClient || {};
}

/**
 * UserPoolClient を read-modify-write で更新する。`mutator(existing) -> patch` を
 * 受けて、existing と patch をマージしてから UpdateUserPoolClientCommand を送る。
 * add/remove callback URL のような「既存配列を加減算する」ロジックを 1 か所にまとめる。
 */
async function mutateUserPoolClient(cognito, userPoolId, clientId, mutator) {
  const existing = await describeUserPoolClient(cognito, userPoolId, clientId);
  const patch = mutator(existing);
  await cognito.send(
    new UpdateUserPoolClientCommand(
      mergeIntoExistingUserPoolClient(userPoolId, clientId, existing, patch),
    ),
  );
}

async function addCallbackUrlToClient(
  cognito,
  userPoolId,
  clientId,
  functionUrl,
  identityProviderName,
) {
  await mutateUserPoolClient(cognito, userPoolId, clientId, (existing) => {
    const callback = `${functionUrl}callback`;
    const newCallbacks = Array.from(new Set([...(existing.CallbackURLs || []), callback]));
    const newLogouts = Array.from(new Set([...(existing.LogoutURLs || []), functionUrl]));
    const supportedIdentityProviders = identityProviderName
      ? Array.from(
          new Set([...(existing.SupportedIdentityProviders || ["COGNITO"]), identityProviderName]),
        )
      : existing.SupportedIdentityProviders;
    return {
      CallbackURLs: newCallbacks,
      LogoutURLs: newLogouts,
      ...(supportedIdentityProviders
        ? { SupportedIdentityProviders: supportedIdentityProviders }
        : {}),
    };
  });
}

async function removeCallbackUrlFromClient(cognito, userPoolId, clientId, functionUrl) {
  await mutateUserPoolClient(cognito, userPoolId, clientId, (existing) => {
    const callback = `${functionUrl}callback`;
    return {
      CallbackURLs: (existing.CallbackURLs || []).filter((u) => u !== callback),
      LogoutURLs: (existing.LogoutURLs || []).filter((u) => u !== functionUrl),
    };
  });
}

async function upsertSamlIdentityProvider(cognito, userPoolId, params) {
  const { providerName, metadataUrl, idpIdentifiers } = params;
  const input = {
    UserPoolId: userPoolId,
    ProviderName: providerName,
    ProviderType: "SAML",
    ProviderDetails: {
      MetadataURL: metadataUrl,
      IDPSignout: "true",
    },
    AttributeMapping: {
      email: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
    },
    IdpIdentifiers: idpIdentifiers,
  };

  try {
    await cognito.send(
      new DescribeIdentityProviderCommand({
        UserPoolId: userPoolId,
        ProviderName: providerName,
      }),
    );
    await cognito.send(new UpdateIdentityProviderCommand(input));
  } catch (err) {
    if (err && err.name !== "ResourceNotFoundException") throw err;
    await cognito.send(new CreateIdentityProviderCommand(input));
  }
}

module.exports = {
  mergeIntoExistingUserPoolClient,
  describeUserPoolClient,
  mutateUserPoolClient,
  addCallbackUrlToClient,
  removeCallbackUrlFromClient,
  upsertSamlIdentityProvider,
};
