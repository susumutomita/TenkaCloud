import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose";
import { type McpOAuthConfig, type McpTeamBinding, mcpIssuer } from "../../mcp-oauth-config.js";

export interface McpTeamPrincipal {
  readonly binding: McpTeamBinding;
  readonly expiresAt: number;
  readonly allowSubmit: boolean;
}
let cachedKeys: { issuer: string; keys: JWTVerifyGetKey } | undefined;

/** Only RS256 access tokens for this exact resource/client; ID and organizer tokens fail closed. */
export async function verifyMcpAccessToken(
  token: string,
  config: McpOAuthConfig,
  clientId: string,
  testKeys?: JWTVerifyGetKey,
): Promise<McpTeamPrincipal> {
  const issuer = mcpIssuer(config);
  if (!cachedKeys || cachedKeys.issuer !== issuer)
    cachedKeys = {
      issuer,
      keys: createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`), {
        timeoutDuration: 5000,
      }),
    };
  const { payload } = await jwtVerify(token, testKeys ?? cachedKeys.keys, {
    algorithms: ["RS256"],
    issuer,
    audience: config.resourceUrl,
    requiredClaims: ["exp", "iat", "sub", "token_use", "client_id", "scope"],
    maxTokenAge: "5m",
    clockTolerance: 5,
  });
  if (
    payload.token_use !== "access" ||
    payload.client_id !== clientId ||
    typeof payload.scope !== "string" ||
    typeof payload.iat !== "number" ||
    typeof payload.exp !== "number" ||
    payload.exp - payload.iat > 300
  )
    throw new Error("Invalid MCP access token");
  const scopes = new Set(payload.scope.split(" "));
  if (!scopes.has(`${config.resourceUrl}/read`)) throw new Error("MCP read scope required");
  const binding = config.bindings.find((entry) => entry.subject === payload.sub);
  const now = Date.now() / 1000;
  if (
    !binding ||
    binding.notBefore > now ||
    binding.expiresAt <= now ||
    payload.iat < binding.notBefore
  )
    throw new Error("MCP team delegation missing or revoked");
  return {
    binding,
    expiresAt: Math.min(payload.exp, binding.expiresAt),
    allowSubmit: binding.allowSubmit && scopes.has(`${config.resourceUrl}/submit`),
  };
}
