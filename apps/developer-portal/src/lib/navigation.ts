import type { Maturity } from "./maturity";

// The single source of truth for navigation across every surface. Landing, docs,
// and the API reference all render their global nav from
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
  { label: "Catalog", href: "/catalog/" },
  { label: "Developers", href: "/developers/" },
  { label: "Docs", href: "/developers/docs/getting-started/" },
  { label: "API Reference", href: "/developers/api/" },
  { label: "Examples", href: "/developers/examples/" },
  { label: "Changelog", href: "/developers/changelog/" },
];

// Footer is grouped; it reuses the same hrefs so there is one link graph.
export const FOOTER_SECTIONS: readonly NavSection[] = [
  {
    title: "Product",
    links: [
      { label: "Overview", href: "/product/" },
      { label: "Problem catalog", href: "/catalog/" },
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
  {
    title: "Community",
    links: [
      { label: "GitHub", href: "https://github.com/susumutomita/TenkaCloud" },
      { label: "Discussions", href: "https://github.com/susumutomita/TenkaCloud/discussions" },
      { label: "Issues", href: "https://github.com/susumutomita/TenkaCloud/issues" },
      {
        label: "Contribute",
        href: "https://github.com/susumutomita/TenkaCloud/blob/main/CONTRIBUTING.md",
      },
    ],
  },
];

// Social links rendered with icons in the footer's Follow column (kept separate
// from the text NavSection model because they carry inline SVG marks).
export interface SocialLink {
  readonly label: string;
  readonly href: string;
}

export const SOCIAL_LINKS: readonly SocialLink[] = [
  { label: "X", href: "https://x.com/tenkacloud" },
  { label: "Instagram", href: "https://www.instagram.com/tenkacloud/" },
];

// Legal pages, surfaced as a link row under the footer disclaimer. JA routes —
// the site is JA-primary.
export const LEGAL_LINKS: readonly NavLink[] = [
  { label: "プライバシーポリシー", href: "/privacy/" },
  { label: "利用規約", href: "/terms/" },
  { label: "特定商取引法に基づく表記", href: "/legal/" },
];
