/**
 * HTTP utilities for API Gateway proxy integration.
 */

// CORS ヘッダ: application-admin-console (別 CloudFront オリジン) からの cross-origin
// 呼び出しでもブラウザがレスポンスを読めるように全レスポンスに付ける。
// Authorization ヘッダを含む preflight は RestApi の defaultCorsPreflightOptions が
// OPTIONS メソッドで別途応答する (MOCK integration)。
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "Content-Type,Authorization",
  "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
  "access-control-expose-headers": "*",
};

function resp(statusCode, body) {
  return {
    statusCode,
    headers: { "content-type": "application/json", ...CORS_HEADERS },
    body: JSON.stringify(body),
  };
}

function getTenantId(event) {
  const claims =
    (event.requestContext &&
      event.requestContext.authorizer &&
      event.requestContext.authorizer.claims) ||
    {};
  return claims["custom:tenantId"];
}

function parseBody(event) {
  if (!event.body) return {};
  try {
    return JSON.parse(event.body);
  } catch {
    return {};
  }
}

module.exports = {
  CORS_HEADERS,
  resp,
  getTenantId,
  parseBody,
};
