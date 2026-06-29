import type { Maturity } from "./maturity";

// The single source of truth for navigation across every surface (ADR-0003 §6:
// "Header / footer / global nav owned by the app shell layout, consumed by every
// route"). Landing, docs, and the API reference all render their global nav from
// this one model, which is what makes the surface feel like one product and what
// the cross-surface navigation tests assert.

export interface NavLink {
  readonly label: string;
  readonly href: string;
  readonly maturity?: Maturity;
}

export interface NavSection {
  readonly title: string;
  readonly links: readonly NavLink[];
}

// Top-level header navigation, identical on every route.
export const PRIMARY_NAV: readonly NavLink[] = [
  { label: "Product", href: "/product/" },
  { label: "Developers", href: "/developers/" },
  { label: "Docs", href: "/developers/docs/getting-started/" },
  { label: "API Reference", href: "/developers/api/" },
  { label: "Examples", href: "/developers/examples/" },
  { label: "Changelog", href: "/developers/changelog/" },
];

// The developer-hub call-to-action surfaced from the landing page. "First Pack"
// is the acceptance-criteria destination a visitor must reach from the landing
// page without leaving the app shell.
export const FIRST_PACK_HREF = "/developers/docs/getting-started/";

// Footer is grouped; it reuses the same hrefs so there is one link graph.
export const FOOTER_SECTIONS: readonly NavSection[] = [
  {
    title: "Product",
    links: [
      { label: "Overview", href: "/product/" },
      { label: "Developer hub", href: "/developers/" },
    ],
  },
  {
    title: "Developers",
    links: [
      { label: "Getting started", href: "/developers/docs/getting-started/" },
      { label: "Concepts", href: "/developers/docs/concepts/problem-packs/" },
      { label: "API reference", href: "/developers/api/" },
      { label: "Examples", href: "/developers/examples/" },
      { label: "Changelog", href: "/developers/changelog/" },
    ],
  },
];

export interface FlatNavEntry extends NavLink {
  readonly group: string;
}

// Flattened, de-duplicated link list used by accessibility / link-graph tooling.
export function flattenNavigation(): readonly FlatNavEntry[] {
  const entries: FlatNavEntry[] = PRIMARY_NAV.map((link) => ({
    ...link,
    group: "Primary",
  }));
  for (const section of FOOTER_SECTIONS) {
    for (const link of section.links) {
      entries.push({ ...link, group: section.title });
    }
  }
  return entries;
}
