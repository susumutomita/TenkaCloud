/**
 * Microsoft Graph API の低レベルクライアント。
 *
 * - `getGraphAccessToken`: client_credentials flow で OAuth token を取得
 * - `graphRequest`: REST 呼び出しのラッパー (auth header / JSON parse / error 整形)
 * - `waitForGraphObjectReady`: instantiate 直後の eventual consistency 用 polling
 * - `escapeODataString`: OData filter 内の `'` を `''` にエスケープ
 */

const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";

async function getGraphAccessToken(credentials) {
  const res = await fetch(
    `https://login.microsoftonline.com/${credentials.tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        grant_type: "client_credentials",
        scope: "https://graph.microsoft.com/.default",
      }),
    },
  );
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Microsoft Graph token request failed (${res.status}): ${detail}`);
  }
  const json = await res.json();
  if (!json.access_token)
    throw new Error("Microsoft Graph token response did not include access_token");
  return json.access_token;
}

async function graphRequest(token, path, options = {}) {
  const res = await fetch(`${GRAPH_BASE_URL}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  if (res.status === 204) return null;
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const message = body && body.error ? `${body.error.code}: ${body.error.message}` : text;
    const error = new Error(`Microsoft Graph request failed (${res.status}) ${path}: ${message}`);
    error.statusCode = res.status;
    throw error;
  }
  return body;
}

/**
 * applicationTemplates/instantiate 直後は application/servicePrincipal object が
 * /applications/{id} や /servicePrincipals/{id} で 404 を返すことがある (Entra の
 * eventual consistency: 数秒〜十数秒の propagation 遅延)。500ms→4s の指数 backoff
 * で polling して readable になるのを待つ。最大 7.5s budget (Lambda 30s timeout から
 * 逆算してこの程度に抑える)。
 */
async function waitForGraphObjectReady(token, path, maxRetries = 4) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await graphRequest(token, `${path}?$select=id`);
      return;
    } catch (err) {
      const isLastAttempt = attempt === maxRetries - 1;
      if (err.statusCode !== 404 || isLastAttempt) throw err;
      const backoffMs = Math.min(500 * 2 ** attempt, 4000);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
}

function escapeODataString(value) {
  return String(value).replace(/'/g, "''");
}

module.exports = {
  GRAPH_BASE_URL,
  getGraphAccessToken,
  graphRequest,
  waitForGraphObjectReady,
  escapeODataString,
};
