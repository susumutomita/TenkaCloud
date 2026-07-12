import { isLoopbackUrl } from "./loopback";

export type CodespacesEnv = Readonly<{
  CODESPACE_NAME?: string;
  GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN?: string;
}>;

function codespacesPortalOrigin(env: CodespacesEnv = process.env): string | undefined {
  const name = env.CODESPACE_NAME?.trim();
  const rawDomain = env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN?.trim();
  if (!name || !rawDomain) return undefined;
  const domain = rawDomain
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^\./, "")
    .replace(/\.$/, "");
  if (!domain) return undefined;
  return `https://${name}-5175.${domain}`.toLowerCase();
}

/** Accept only a syntactically exact loopback or current Codespaces portal origin. */
export function isAllowedCorsOrigin(origin: string, env: CodespacesEnv = process.env): boolean {
  try {
    const url = new URL(origin);
    if (
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.origin !== origin
    ) {
      return false;
    }
    if (isLoopbackUrl(url.origin)) return true;
    return url.protocol === "https:" && url.origin.toLowerCase() === codespacesPortalOrigin(env);
  } catch {
    return false;
  }
}

export function corsHeaders(
  origin: string | undefined,
  env: CodespacesEnv = process.env,
): Record<string, string> {
  if (origin === undefined || !isAllowedCorsOrigin(origin, env)) return {};
  return {
    "access-control-allow-origin": origin,
    vary: "Origin",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
  };
}
