import { type CodespacesEnv, codespacesForwardedOrigin } from "./codespaces-origin";

export type { CodespacesEnv } from "./codespaces-origin";

const LOCAL_PORTAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Correct as a default for two independent reasons, not one: on the host/dev path the
 * Portal is Vite, whose own dev-server port is fixed at 5175 regardless of the API's own
 * (often OS-auto-assigned, readiness.ts's `freeLoopbackPort`) port — server.ts has no 5175
 * default of its own there. On the container path, Portal and API share one origin by
 * construction, and 5175 is simply `LOCAL_API_PORT`'s default (Dockerfile,
 * compose.local.yaml). A caller that knows the actual bound port in container mode
 * (server.ts does, once `startLocalPlayServer` receives it and `portalDistDir` is set)
 * must pass it explicitly — `LOCAL_API_PORT` is a supported override, and both the
 * direct-origin check and the Codespaces-forwarded-origin check below are port-specific,
 * not just this default.
 */
const DEFAULT_LOCAL_API_PORT = 5175;

/** Accept only the exact local or current Codespaces Participant Portal origin. */
export function isAllowedCorsOrigin(
  origin: string,
  env: CodespacesEnv = process.env,
  apiPort: number = DEFAULT_LOCAL_API_PORT,
): boolean {
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
    if (
      url.protocol === "http:" &&
      LOCAL_PORTAL_HOSTNAMES.has(url.hostname) &&
      url.port === String(apiPort)
    ) {
      return true;
    }
    return url.protocol === "https:" && url.origin === codespacesForwardedOrigin(apiPort, env);
  } catch {
    return false;
  }
}

export function corsHeaders(
  origin: string | undefined,
  env: CodespacesEnv = process.env,
  apiPort: number = DEFAULT_LOCAL_API_PORT,
): Record<string, string> {
  if (origin === undefined || !isAllowedCorsOrigin(origin, env, apiPort)) return {};
  return {
    "access-control-allow-origin": origin,
    vary: "Origin",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
  };
}

/**
 * [#2906 round-2 audit] `/runtime-config.json` (server.ts) is deliberately unauthenticated
 * — it is what bootstraps a fresh page load, before any script has a token to send — so
 * the `Host` header it trusts to build `apiBaseUrl` (and hands back `localTeamLoginKey`
 * regardless of the header) is the ONLY gate on who can read it. The host/dev path's Vite
 * dev server blocked exactly this class of request via `server.allowedHosts`; same-origin
 * container serving has no equivalent unless this function is called. Without it, DNS
 * rebinding — a page loaded from `attacker.example:<apiPort>` whose DNS is re-pointed to
 * 127.0.0.1 after load — is same-origin from the BROWSER's point of view (same hostname
 * string, same port; the Same-Origin Policy does not re-check the resolved IP), so its JS
 * can `fetch("/runtime-config.json")` with no CORS preflight and no Origin-header gate to
 * fail, and read the token straight out of the JSON body.
 */
export function isTrustedRuntimeConfigHost(
  hostHeader: string,
  env: CodespacesEnv = process.env,
  apiPort: number = DEFAULT_LOCAL_API_PORT,
): boolean {
  for (const hostname of LOCAL_PORTAL_HOSTNAMES) {
    if (hostHeader === `${hostname}:${apiPort}`) return true;
  }
  const forwarded = codespacesForwardedOrigin(apiPort, env);
  return forwarded !== undefined && hostHeader === forwarded.slice("https://".length);
}
