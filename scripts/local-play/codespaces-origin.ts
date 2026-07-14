export type CodespacesEnv = Readonly<{
  CODESPACE_NAME?: string;
  GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN?: string;
}>;

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function codespacesIdentity(
  env: CodespacesEnv,
): { readonly name: string; readonly domain: string } | undefined {
  const name = env.CODESPACE_NAME?.trim();
  const rawDomain = env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN?.trim();
  if (!name || !rawDomain || !DNS_LABEL.test(name)) return undefined;
  try {
    const url = new URL(rawDomain.includes("://") ? rawDomain : `https://${rawDomain}`);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return undefined;
    }
    const labels = url.hostname.split(".");
    if (labels.length < 2 || labels.some((label) => !DNS_LABEL.test(label))) return undefined;
    return { name, domain: url.hostname };
  } catch {
    return undefined;
  }
}

export function codespacesForwardedOrigin(
  port: number,
  env: CodespacesEnv = process.env,
): string | undefined {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
  const identity = codespacesIdentity(env);
  if (!identity) return undefined;
  const forwardedLabel = `${identity.name}-${port}`;
  if (!DNS_LABEL.test(forwardedLabel)) return undefined;
  const hostname = `${forwardedLabel}.${identity.domain}`;
  const url = new URL(`https://${hostname}`);
  if (url.hostname !== hostname || url.origin !== `https://${hostname}`) return undefined;
  return url.origin;
}
