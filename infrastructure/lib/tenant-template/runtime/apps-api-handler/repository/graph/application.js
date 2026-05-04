/**
 * Microsoft Graph - Enterprise Application / Service Principal 操作。
 *
 * `ensureEnterpriseApplication` がメインの orchestrator: per-tenant の Enterprise
 * App を「無ければ instantiate、あれば再利用」して SAML SSO 用に PATCH する。
 * SAML signing certificate も無ければ追加する。
 */

const { graphRequest, waitForGraphObjectReady, escapeODataString } = require("./client");

const DEFAULT_ENTRA_APPLICATION_TEMPLATE_ID = "8adf8e6e-67b2-4cf2-a259-e3dc5476c621";

function sanitizeDisplayNamePart(value) {
  return String(value || "")
    .replace(/[^\w .:@-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function addYears(date, years) {
  const next = new Date(date);
  next.setUTCFullYear(next.getUTCFullYear() + years);
  return next;
}

async function findApplicationByDisplayName(token, displayName) {
  const filter = encodeURIComponent(`displayName eq '${escapeODataString(displayName)}'`);
  const res = await graphRequest(
    token,
    `/applications?$filter=${filter}&$select=id,appId,displayName`,
  );
  return (res.value || [])[0] || null;
}

async function findServicePrincipalByAppId(token, appId) {
  const filter = encodeURIComponent(`appId eq '${escapeODataString(appId)}'`);
  const res = await graphRequest(
    token,
    `/servicePrincipals?$filter=${filter}&$select=id,appId,displayName,appRoles,preferredTokenSigningKeyThumbprint`,
  );
  return (res.value || [])[0] || null;
}

async function instantiateEnterpriseApplication(token, displayName, applicationTemplateId) {
  const templateId = applicationTemplateId || DEFAULT_ENTRA_APPLICATION_TEMPLATE_ID;
  return await graphRequest(token, `/applicationTemplates/${templateId}/instantiate`, {
    method: "POST",
    body: JSON.stringify({ displayName }),
  });
}

async function ensureEnterpriseApplication(
  token,
  brokerTenantId,
  tenantId,
  functionUrl,
  brokerConfig,
  samlValues,
) {
  const displayName = sanitizeDisplayNamePart(
    `TenkaCloud ${samlValues.userPoolId} ${brokerConfig.profileId} SAML Broker`,
  );
  let application = await findApplicationByDisplayName(token, displayName);
  let servicePrincipal = application
    ? await findServicePrincipalByAppId(token, application.appId)
    : null;

  if (!application || !servicePrincipal) {
    const created = await instantiateEnterpriseApplication(
      token,
      displayName,
      brokerConfig.applicationTemplateId,
    );
    application = created.application;
    servicePrincipal = created.servicePrincipal;
    // instantiate 直後の object は eventual consistency で 404 を返すので readable になるまで待つ
    await waitForGraphObjectReady(token, `/applications/${application.id}`);
    await waitForGraphObjectReady(token, `/servicePrincipals/${servicePrincipal.id}`);
  }

  await graphRequest(token, `/applications/${application.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      identifierUris: [samlValues.spEntityId],
      // Microsoft Entra の "App ID URI uniqueness policy" (2024〜 default 有効) は
      // identifierUris に tenant 検証済みドメイン / tenant ID / app ID を含むことを
      // 要求するが、Cognito の SP Entity ID (`urn:amazon:cognito:sp:{UserPoolId}`) は
      // この形式に変えられない (Cognito 側がこのフォーマットを送ってくる)。
      // requestedAccessTokenVersion=2 を指定すると policy バイパスが効き、SAML SSO
      // は access token 不使用なので機能影響なし。
      // https://aka.ms/identifier-uri-formatting-error
      api: { requestedAccessTokenVersion: 2 },
      web: {
        redirectUris: [samlValues.acsUrl],
        homePageUrl: functionUrl,
      },
    }),
  });

  await graphRequest(token, `/servicePrincipals/${servicePrincipal.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      preferredSingleSignOnMode: "saml",
      appRoleAssignmentRequired: false,
    }),
  });

  if (!servicePrincipal.preferredTokenSigningKeyThumbprint) {
    const certificate = await graphRequest(
      token,
      `/servicePrincipals/${servicePrincipal.id}/addTokenSigningCertificate`,
      {
        method: "POST",
        body: JSON.stringify({
          displayName: `CN=${displayName}`,
          endDateTime: addYears(new Date(), 3).toISOString(),
        }),
      },
    );
    await graphRequest(token, `/servicePrincipals/${servicePrincipal.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        preferredTokenSigningKeyThumbprint: certificate.thumbprint,
      }),
    });
  }

  const metadataUrl = `https://login.microsoftonline.com/${encodeURIComponent(
    brokerTenantId,
  )}/federationmetadata/2007-06/federationmetadata.xml?appid=${encodeURIComponent(application.appId)}`;

  return {
    displayName,
    applicationObjectId: application.id,
    appId: application.appId,
    servicePrincipalId: servicePrincipal.id,
    metadataUrl,
    spEntityId: samlValues.spEntityId,
    acsUrl: samlValues.acsUrl,
    appRoles: servicePrincipal.appRoles || [],
  };
}

module.exports = {
  DEFAULT_ENTRA_APPLICATION_TEMPLATE_ID,
  findApplicationByDisplayName,
  findServicePrincipalByAppId,
  instantiateEnterpriseApplication,
  ensureEnterpriseApplication,
};
