import type { Maturity } from "@/lib/maturity";

// The docs page tree (ADR-0003 §6: "Sidebar / nav tree owned by the Fumadocs page
// tree"). Until the Fumadocs swap (tracked as a follow-up), this typed registry is
// the single source of truth that drives the docs sidebar, the search index, and
// the build-time link checker. Each entry maps a route slug to a real MDX file
// under src/app/developers/docs and carries searchable text.

export interface DocHeading {
  readonly id: string;
  readonly text: string;
}

export interface DocPage {
  readonly slug: string;
  readonly href: string;
  readonly title: string;
  readonly description: string;
  readonly maturity: Maturity;
  readonly section: string;
  // Searchable body text (plain prose extracted from the MDX) plus headings.
  readonly headings: readonly DocHeading[];
  readonly body: string;
}

export interface DocSection {
  readonly title: string;
  readonly pages: readonly DocPage[];
}

export const DOC_PAGES: readonly DocPage[] = [
  {
    slug: "getting-started",
    href: "/developers/docs/getting-started/",
    title: "Getting started",
    description: "Deploy your First Pack and reach the participant portal.",
    maturity: "stable",
    section: "Start here",
    headings: [
      { id: "first-pack", text: "Deploy your First Pack" },
      { id: "prerequisites", text: "Prerequisites" },
      { id: "next-steps", text: "Next steps" },
    ],
    body: "Getting started with TenkaCloud. Deploy your First Pack in Lite mode, register a team, and watch scoring flow through the participant portal. Prerequisites include Bun and an AWS account for a real deploy.",
  },
  {
    slug: "concepts/problem-packs",
    href: "/developers/docs/concepts/problem-packs/",
    title: "Problem packs",
    description: "How Battle and Challenge packs are authored and scored.",
    maturity: "stable",
    section: "Concepts",
    headings: [
      { id: "what-is-a-pack", text: "What is a problem pack" },
      { id: "battle-vs-challenge", text: "Battle versus Challenge" },
      { id: "scoring-kinds", text: "Scoring kinds" },
    ],
    body: "A problem pack is the unit of competition content. Battle packs are real-time and head-to-head; Challenge packs are self-paced and evergreen. Each pack carries metadata, a CloudFormation template, and an optional portal plugin. Scoring uses one of six built-in kinds.",
  },
];

export const DOC_SECTIONS: readonly DocSection[] = buildSections(DOC_PAGES);

function buildSections(pages: readonly DocPage[]): readonly DocSection[] {
  const order: string[] = [];
  const grouped = new Map<string, DocPage[]>();
  for (const page of pages) {
    if (!grouped.has(page.section)) {
      grouped.set(page.section, []);
      order.push(page.section);
    }
    grouped.get(page.section)?.push(page);
  }
  return order.map((title) => ({
    title,
    pages: grouped.get(title) ?? [],
  }));
}

export function findDocBySlug(slug: string): DocPage | undefined {
  return DOC_PAGES.find((page) => page.slug === slug);
}
