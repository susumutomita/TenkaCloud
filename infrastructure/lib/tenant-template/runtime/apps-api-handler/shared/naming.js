/**
 * Pure helpers for naming, email normalization, and SAML value derivation.
 * 副作用無し: process.env も SDK client も触らない (テスタブルな pure functions のみ)。
 * 環境依存値 (USER_POOL_ID, COGNITO_DOMAIN) は引数で受け取る。
 */

const crypto = require("node:crypto");

function makeFunctionName(tenantId, appId) {
  // Lambda function 名は 64 文字まで。TenkaCloud-app- prefix + tenantId + appId を truncate。
  // 衝突回避のため appId 側を優先して残す。
  const base = `TenkaCloud-app-${tenantId}-${appId}`;
  return base.length > 64 ? base.slice(0, 64) : base;
}

function normalizeGuestEmails(value) {
  if (!value) return [];
  const raw = Array.isArray(value) ? value : String(value).split(/[,\s]+/);
  return Array.from(
    new Set(
      raw.map((email) => String(email).trim().toLowerCase()).filter((email) => email.length > 0),
    ),
  );
}

function assertGuestEmails(guestEmails) {
  const invalid = guestEmails.filter((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
  if (invalid.length > 0) {
    throw new Error(`invalid guest email address: ${invalid.join(", ")}`);
  }
}

function makeBrokerProviderName(brokerConfig) {
  const source = brokerConfig.graphParameterName || brokerConfig.profileId || "default";
  const suffix = crypto.createHash("sha256").update(source).digest("hex").slice(0, 10);
  return `EntraBroker-${suffix}`;
}

function getCognitoSamlValues(cognitoDomain, userPoolId) {
  if (!cognitoDomain || !userPoolId) {
    throw new Error("COGNITO_DOMAIN and USER_POOL_ID are required for Entra broker SAML setup");
  }
  return {
    spEntityId: `urn:amazon:cognito:sp:${userPoolId}`,
    acsUrl: `${cognitoDomain}/saml2/idpresponse`,
  };
}

module.exports = {
  makeFunctionName,
  normalizeGuestEmails,
  assertGuestEmails,
  makeBrokerProviderName,
  getCognitoSamlValues,
};
