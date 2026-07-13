import { buildRuntimeConfig } from "../ops/participant-portal-runtime-config";
import { type CodespacesEnv, codespacesForwardedOrigin } from "./codespaces-origin";

/**
 * [#2527 Slice 6] Browser-facing URL presentation for local play, extracted verbatim
 * from `scripts/tenkacloud-local.ts`: rewrites loopback URLs into GitHub Codespaces
 * forwarded URLs (one isolated origin per port) and builds the participant-portal
 * runtime-config for a local session. Pure presentation — no process or fs access.
 */

const LOOPBACK_BROWSER_URL_RE =
  /\bhttp:\/\/(?:127\.0\.0\.1|localhost):(\d+)(?=\/|[?#]|[\s`"'<>)]|$)/g;
const LOCAL_API_PROXY_PREFIX = "/__tenkacloud-local-api";

export type { CodespacesEnv } from "./codespaces-origin";

function browserApiBaseUrl(apiBaseUrl: string, env: CodespacesEnv = process.env): string {
  try {
    const url = new URL(apiBaseUrl);
    const port = Number(url.port);
    if (Number.isInteger(port) && port > 0) {
      const portalOrigin = codespacesForwardedOrigin(5175, env);
      return portalOrigin ? `${portalOrigin}${LOCAL_API_PROXY_PREFIX}` : apiBaseUrl;
    }
  } catch {
    // buildRuntimeConfig validates the URL and reports the real error below.
  }
  return apiBaseUrl;
}

export function browserDisplayText(text: string, env: CodespacesEnv = process.env): string {
  return text.replace(LOOPBACK_BROWSER_URL_RE, (match, port: string) => {
    return codespacesForwardedOrigin(Number(port), env) ?? match;
  });
}

export function buildLocalRuntimeConfig(
  apiBaseUrl: string,
  participantToken: string,
  env: CodespacesEnv = process.env,
) {
  // `out`/`print` are unused by buildRuntimeConfig (it returns the object; up()
  // writes the file itself) — pass inert values to satisfy the option type.
  return {
    ...buildRuntimeConfig({
      cloudMode: "local",
      portalMode: "backend",
      apiBaseUrl: browserApiBaseUrl(apiBaseUrl, env),
      eventTitle: "TenkaCloud Local",
      eventRegion: "local",
      out: "",
      print: false,
    }),
    localTeamLoginKey: participantToken,
  };
}
