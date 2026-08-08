// Locale-aware path mapping for the global header language switch (#2429).
//
// The site is JA-primary with an EN mirror on a small set of routes; the shared
// docs surface has no mirror. `mirrorPath` returns the counterpart-locale path
// for the current path: the exact mirror for a bilingual route, or the other
// locale's home for any unmirrored route (docs, product) — the same behavior the
// legacy landing's switch had (it only toggled the home).

export type Locale = "ja" | "en";

const HOME_JA = "/";
const HOME_EN = "/en/";

// [ja, en] pairs. Keep in sync with the bilingual routes in routes.ts.
const MIRROR_PAIRS: readonly (readonly [string, string])[] = [
  ["/", "/en/"],
  ["/catalog/", "/en/catalog/"],
  ["/privacy/", "/en/privacy/"],
  ["/terms/", "/en/terms/"],
  ["/legal/", "/en/legal/"],
  // Issue #2950: the machine API reference is bilingual, so the switch has a real
  // counterpart here instead of falling back to the other locale's home.
  ["/developers/api/machine/", "/en/developers/api/machine/"],
];

// Normalize to a trailing-slash path so matching is consistent with routes.ts
// (which stores every route with a trailing slash) regardless of how the caller
// supplies the current pathname.
function withTrailingSlash(path: string): string {
  if (path === "") {
    return HOME_JA;
  }
  return path.endsWith("/") ? path : `${path}/`;
}

export function localeOf(pathname: string): Locale {
  const path = withTrailingSlash(pathname);
  return path === HOME_EN || path.startsWith("/en/") ? "en" : "ja";
}

// The counterpart-locale path for `pathname`: the exact mirror when the route is
// bilingual, otherwise the other locale's home.
export function mirrorPath(pathname: string): string {
  const path = withTrailingSlash(pathname);
  if (localeOf(path) === "en") {
    const pair = MIRROR_PAIRS.find(([, en]) => en === path);
    return pair ? pair[0] : HOME_JA;
  }
  const pair = MIRROR_PAIRS.find(([ja]) => ja === path);
  return pair ? pair[1] : HOME_EN;
}
