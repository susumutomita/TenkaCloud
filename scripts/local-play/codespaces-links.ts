import { buildRuntimeConfig } from "../ops/participant-portal-runtime-config";

/**
 * [#2527 Slice 6] Browser-facing URL presentation for local play, extracted verbatim
 * from `scripts/tenkacloud-local.ts`: rewrites loopback URLs into GitHub Codespaces
 * forwarded URLs (portal proxy paths) and builds the participant-portal
 * runtime-config for a local session. Pure presentation — no process or fs access.
 */

const PARTICIPANT_PORTAL_DEV_PORT = 5175;
const LOCAL_API_PROXY_PATH = "/__tenkacloud-local-api";
const LOCAL_CHALLENGE_PROXY_PATH = "/__tenkacloud-local-port";
const LOOPBACK_BROWSER_URL_RE =
  /\bhttp:\/\/(?:127\.0\.0\.1|localhost):(\d+)(?=\/|[?#]|[\s`"'<>)]|$)/g;

export type CodespacesEnv = Readonly<{
  CODESPACE_NAME?: string;
  GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN?: string;
}>;

function codespacesForwardedUrl(
  port: number,
  env: CodespacesEnv = process.env,
): string | undefined {
  const name = env.CODESPACE_NAME?.trim();
  const rawDomain = env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN?.trim();
  if (!name || !rawDomain) return undefined;
  const domain = rawDomain
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^\./, "")
    .replace(/\.$/, "");
  if (!domain) return undefined;
  return `https://${name}-${port}.${domain}`;
}

function browserApiBaseUrl(apiBaseUrl: string, env: CodespacesEnv = process.env): string {
  const codespacesPortalUrl = codespacesForwardedUrl(PARTICIPANT_PORTAL_DEV_PORT, env);
  if (codespacesPortalUrl) return `${codespacesPortalUrl}${LOCAL_API_PROXY_PATH}`;
  try {
    const url = new URL(apiBaseUrl);
    const port = Number(url.port);
    if (Number.isInteger(port) && port > 0) {
      return codespacesForwardedUrl(port, env) ?? apiBaseUrl;
    }
  } catch {
    // buildRuntimeConfig validates the URL and reports the real error below.
  }
  return apiBaseUrl;
}

export function browserDisplayText(text: string, env: CodespacesEnv = process.env): string {
  return text.replace(LOOPBACK_BROWSER_URL_RE, (match, port: string) => {
    const portalUrl = codespacesForwardedUrl(PARTICIPANT_PORTAL_DEV_PORT, env);
    if (!portalUrl) return match;
    return `${portalUrl}${LOCAL_CHALLENGE_PROXY_PATH}/${port}`;
  });
}

export function buildLocalRuntimeConfig(apiBaseUrl: string, env: CodespacesEnv = process.env) {
  // `out`/`print` are unused by buildRuntimeConfig (it returns the object; up()
  // writes the file itself) — pass inert values to satisfy the option type.
  return buildRuntimeConfig({
    cloudMode: "local",
    portalMode: "backend",
    apiBaseUrl: browserApiBaseUrl(apiBaseUrl, env),
    eventTitle: "TenkaCloud Local",
    eventRegion: "local",
    out: "",
    print: false,
  });
}
