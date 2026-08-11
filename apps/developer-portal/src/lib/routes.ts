import { DOC_PAGES } from "@/content/docs-registry";

// The complete set of internal route paths the app serves. The build-time link
// checker (scripts/check-internal-links.ts) treats any internal href that is not
// in this set as a broken link and fails the build (Issue #2101).

export const STATIC_ROUTES: readonly string[] = [
  "/",
  "/product/",
  // Public marketing catalog (#2408), JA primary + EN mirror.
  "/catalog/",
  "/developers/",
  "/developers/api/",
  // Issue #2950: the machine (M2M) API reference, JA primary + EN mirror.
  "/developers/api/machine/",
  "/developers/examples/",
  "/developers/changelog/",
  // Legal pages migrated from the static landing.
  "/privacy/",
  "/terms/",
  "/legal/",
  // English mirrors. The JA pages above are the primary; /en/* mirror the marketing
  // home and catalog, and the legal pages there are English reference versions.
  "/en/",
  "/en/catalog/",
  "/en/privacy/",
  "/en/terms/",
  "/en/legal/",
  "/en/developers/api/machine/",
];

export function allRoutes(): readonly string[] {
  const docRoutes = DOC_PAGES.map((page) => page.href);
  return [...STATIC_ROUTES, ...docRoutes];
}

// Normalizes an href to its path portion (strips hash and query) for membership
// checks against the route set.
export function normalizeHref(href: string): string {
  const withoutHash = href.split("#")[0]?.split("?")[0] ?? href;
  if (withoutHash === "") {
    // A pure-hash link (e.g. "#section") points at the current page.
    return "";
  }
  return withoutHash;
}

export function isInternalHref(href: string): boolean {
  return href.startsWith("/");
}

export function isKnownRoute(href: string, routes: readonly string[] = allRoutes()): boolean {
  const path = normalizeHref(href);
  if (path === "") {
    // In-page anchor; always valid relative to its own page.
    return true;
  }
  return routes.includes(path);
}
