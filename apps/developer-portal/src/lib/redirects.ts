// Legacy landing URLs and README anchors redirect to the new canonical routes
// (legacy-route migration: "Add redirects from the old landing URLs and README
// anchors to the new routes ... no dead links"). This is the single source of
// truth; the static route stubs and the redirect tests both read it.

export interface RedirectRule {
  // The legacy path (the route that used to exist).
  readonly from: string;
  // The canonical destination it must preserve.
  readonly to: string;
}

export const REDIRECTS: readonly RedirectRule[] = [
  // The old standalone docs entry point.
  { from: "/docs", to: "/developers/docs/getting-started/" },
  // The old "get started" landing CTA.
  { from: "/get-started", to: "/developers/docs/getting-started/" },
  // The old API page.
  { from: "/api", to: "/developers/api/" },
  // The old changelog location.
  { from: "/changelog", to: "/developers/changelog/" },
];

export function resolveRedirect(from: string): string | undefined {
  const normalized = from.replace(/\/+$/, "") || "/";
  return REDIRECTS.find((rule) => rule.from === normalized)?.to;
}
