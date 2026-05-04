/**
 * broker Entra ID + Cognito SAML IdP の構成ワークフロー。
 *
 * `createBrokerSamlService(ctx).configure({...})` でステップを順に実行:
 *   1. SSM から broker Graph creds を取得 (無ければ guestEmails 必須を満たさず error or null return)
 *   2. Microsoft Graph token を取得
 *   3. per-tenant Enterprise Application を ensure (作成 or 既存再利用)
 *   4. Cognito SAML Identity Provider を upsert (Entra との SAML federation)
 *   5. guest user を invite + appRole assign
 *
 * 戻り値は DDB Apps row の brokerEntra フィールドにそのまま入る。
 */

const ssmRepo = require("../repository/ssm");
const cognitoRepo = require("../repository/cognito");
const graphClient = require("../repository/graph/client");
const graphApplication = require("../repository/graph/application");
const graphInvitation = require("../repository/graph/invitation");
const { makeBrokerProviderName, getCognitoSamlValues } = require("../shared/naming");
const { assertEmailsInAllowlist } = require("../shared/domain-allowlist");

function createBrokerSamlService(ctx) {
  const { ssm, cognito, env } = ctx;

  async function configure({
    tenantId,
    functionUrl,
    guestEmails,
    brokerConfig,
    allowedEmailDomains,
  }) {
    // memory: ドメイン allowlist の二重安全弁。apps-service 側でも check 済だが
    // broker-saml は他 caller (将来の auth-proxy / JIT invitation) からも呼ばれる
    // 想定なので、ここでも独立に防御する。
    assertEmailsInAllowlist(guestEmails, allowedEmailDomains || []);

    const credentials = await ssmRepo.loadBrokerEntraCredentials(ssm, brokerConfig);
    if (!credentials) {
      if (guestEmails.length > 0) {
        throw new Error("broker Entra Graph credentials are not configured");
      }
      return null;
    }

    const token = await graphClient.getGraphAccessToken(credentials);
    const enterpriseApp = await graphApplication.ensureEnterpriseApplication(
      token,
      credentials.tenantId,
      tenantId,
      functionUrl,
      brokerConfig,
      { ...getCognitoSamlValues(env.cognitoDomain, env.userPoolId), userPoolId: env.userPoolId },
    );
    const idpIdentifiers = Array.from(
      new Set(["broker.TenkaCloud", ...guestEmails.map((email) => email.split("@")[1])]),
    );
    const providerName = makeBrokerProviderName(brokerConfig);
    await cognitoRepo.upsertSamlIdentityProvider(cognito, env.userPoolId, {
      providerName,
      metadataUrl: enterpriseApp.metadataUrl,
      idpIdentifiers,
    });
    const invitedUsers = await graphInvitation.inviteAndAssignGuestUsers(
      token,
      enterpriseApp,
      guestEmails,
      functionUrl,
    );
    // JIT invitation (auth-proxy) が同じ role を割り当てる必要があるので、
    // broker creds (broker tenantId) と一緒に role / SP id を露出する。
    const appRole = graphInvitation.resolveAppRole(enterpriseApp);

    return {
      providerName,
      profileId: brokerConfig.profileId,
      enterpriseApplicationDisplayName: enterpriseApp.displayName,
      applicationObjectId: enterpriseApp.applicationObjectId,
      appId: enterpriseApp.appId,
      servicePrincipalId: enterpriseApp.servicePrincipalId,
      appRoleId: appRole.id,
      brokerEntraTenantId: credentials.tenantId,
      metadataUrl: enterpriseApp.metadataUrl,
      spEntityId: enterpriseApp.spEntityId,
      acsUrl: enterpriseApp.acsUrl,
      invitedUsers,
    };
  }

  return { configure };
}

module.exports = { createBrokerSamlService };
