import { type CodespacesEnv, codespacesForwardedOrigin } from "./codespaces-origin";

export type { CodespacesEnv } from "./codespaces-origin";

const LOCAL_PORTAL_ORIGINS = new Set([
  "http://localhost:5175",
  "http://127.0.0.1:5175",
  // eslint-disable-next-line sonarjs/no-clear-text-protocols -- exact local-only IPv6 origin
  "http://[::1]:5175",
]);

/** Accept only the exact local or current Codespaces Participant Portal origin. */
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
    if (LOCAL_PORTAL_ORIGINS.has(url.origin)) return true;
    return url.protocol === "https:" && url.origin === codespacesForwardedOrigin(5175, env);
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
