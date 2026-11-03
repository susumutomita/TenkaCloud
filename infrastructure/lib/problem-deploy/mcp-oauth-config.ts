import { z } from "zod";

const binding = z.strictObject({
  subject: z.uuid(),
  tenantId: z.string().min(1).max(128),
  eventId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
  teamId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
  jobIds: z
    .array(z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/))
    .min(1)
    .max(16),
  notBefore: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
  allowSubmit: z.boolean(),
});
const configSchema = z.strictObject({
  userPoolId: z.string().regex(/^[a-z]{2}-[a-z]+-\d_[A-Za-z0-9]+$/),
  resourceUrl: z.url(),
  callbackUrls: z.array(z.url()).min(1).max(8),
  bindings: z.array(binding).min(1).max(16),
});
export type McpOAuthConfig = z.infer<typeof configSchema>;
export type McpTeamBinding = z.infer<typeof binding>;

/** Explicit deployment configuration; never populated from request claims or tool arguments. */
export function parseMcpOAuthConfig(raw: string | undefined): McpOAuthConfig | undefined {
  if (raw === undefined) return undefined;
  const config = configSchema.parse(JSON.parse(raw));
  const resource = new URL(config.resourceUrl);
  if (
    resource.protocol !== "https:" ||
    resource.username ||
    resource.password ||
    resource.search ||
    resource.hash ||
    resource.pathname !== "/mcp"
  )
    throw new Error(
      "MCP resourceUrl must be the exact HTTPS /mcp URL without credentials or query.",
    );
  for (const callback of config.callbackUrls) {
    const url = new URL(callback);
    if (
      (url.protocol !== "https:" &&
        !(
          url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
        )) ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new Error(
        "MCP callback must be HTTPS or exact loopback HTTP, without credentials or fragment.",
      );
  }
  if (new Set(config.bindings.map((entry) => entry.subject)).size !== config.bindings.length)
    throw new Error("Each Cognito subject must have exactly one explicit MCP team binding.");
  for (const entry of config.bindings) {
    if (entry.expiresAt <= entry.notBefore || new Set(entry.jobIds).size !== entry.jobIds.length)
      throw new Error("MCP binding must have a valid time window and unique job IDs.");
  }
  return config;
}

export function mcpIssuer(config: McpOAuthConfig): string {
  const region = config.userPoolId.split("_")[0];
  return `https://cognito-idp.${region}.amazonaws.com/${config.userPoolId}`;
}
