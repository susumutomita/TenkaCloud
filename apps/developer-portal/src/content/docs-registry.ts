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
  // [Issue #2103] Reference pages. The normative tables on these pages render the
  // GENERATED reference-data module (src/content/reference-data.ts), which the
  // generator derives from the real pack/problem schemas, runtime capability
  // declarations, the pack CLI usage strings, and the validator error-code
  // registry. The drift check fails the build when those sources change without a
  // regenerate.
  {
    slug: "reference/pack-manifest",
    href: "/developers/docs/reference/pack-manifest/",
    title: "Pack manifest reference",
    description: "Every tenkacloud-pack.json field, generated from the manifest schema.",
    maturity: "stable",
    section: "Reference",
    headings: [
      { id: "fields", text: "Fields" },
      { id: "example", text: "Example" },
    ],
    body: "Pack manifest reference. The tenkacloud-pack.json fields generated from the PackManifestSchema: schemaVersion, id, version, core, title, description, license, problemsRoot, requiredRuntimes, dependencies. The manifest is inert with no scripts or hooks.",
  },
  {
    slug: "reference/problem-metadata",
    href: "/developers/docs/reference/problem-metadata/",
    title: "Problem metadata reference",
    description: "Every metadata.json field, derived from the SDK validator.",
    maturity: "stable",
    section: "Reference",
    headings: [
      { id: "fields", text: "Fields" },
      { id: "runtime-declaration", text: "Runtime declaration" },
      { id: "example", text: "Example" },
    ],
    body: "Problem metadata reference. The metadata.json fields derived from the ProblemMetadata contract and validateProblemMetadata: id, runtime, cfnTemplate, scoring, endpoints, phases, disruptions. Runtime is a single descriptor or a composite of 2 to 8 targets.",
  },
  {
    slug: "reference/runtime-matrix",
    href: "/developers/docs/reference/runtime-matrix/",
    title: "Runtime capability matrix",
    description: "AWS, GCP, Azure, and Sakura runtime support, derived from the runtime package.",
    maturity: "preview",
    section: "Reference",
    headings: [
      { id: "matrix", text: "Matrix" },
      { id: "support-classes", text: "Support classes" },
    ],
    body: "Runtime capability matrix for AWS, GCP, Azure, and Sakura derived from problem-runtime. AWS cloudformation is executable and stable; sakura apprun, azure bicep, and gcp infra-manager are reserved roadmap targets; docker compose is a local container runtime.",
  },
  {
    slug: "reference/cli",
    href: "/developers/docs/reference/cli/",
    title: "CLI reference",
    description: "Every tenkacloud pack command, parsed from the CLI usage strings.",
    maturity: "stable",
    section: "Reference",
    headings: [
      { id: "commands", text: "Commands" },
      { id: "exit-codes", text: "Exit codes" },
      { id: "example", text: "Example" },
    ],
    body: "CLI reference for the tenkacloud pack tool. Commands parsed from the CLI usage strings: validate, init, install, list, inspect, remove, activate, deactivate. Exit codes 0 success, 1 refusal, 2 tool failure. No update command; a new version is a separate install.",
  },
  {
    slug: "reference/validation-errors",
    href: "/developers/docs/reference/validation-errors/",
    title: "Validation error reference",
    description: "Every validator diagnostic code with a user-facing explanation.",
    maturity: "stable",
    section: "Reference",
    headings: [
      { id: "codes", text: "Codes" },
      { id: "reading-a-diagnostic", text: "Reading a diagnostic" },
    ],
    body: "Validation error reference. Every namespaced ValidationDiagnosticCode from the SDK with a user-facing explanation: PACK_DIR_MISSING, PACK_MANIFEST_MISSING, PACK_MANIFEST_UNREADABLE, PACK_MANIFEST_INVALID, PACK_PROBLEMS_ROOT_MISSING, PACK_PROBLEMS_ROOT_TRAVERSAL, PACK_DUPLICATE_PROBLEM_ID, PACK_ARTIFACT_TRAVERSAL, PACK_ARTIFACT_MISSING, PROBLEM_METADATA_INVALID, RUNTIME_MISMATCH.",
  },
  {
    slug: "reference/security-provenance",
    href: "/developers/docs/reference/security-provenance/",
    title: "Security and provenance model",
    description: "Inert manifests, content digests, and pinned Git provenance.",
    maturity: "stable",
    section: "Reference",
    headings: [
      { id: "guarantees", text: "Guarantees" },
      { id: "how-provenance-is-recorded", text: "How provenance is recorded" },
      { id: "what-a-pack-cannot-do", text: "What a pack cannot do" },
    ],
    body: "Security and provenance model. Inert manifests with no scripts or hooks, immutable content-addressed SHA-256 snapshots, pinned Git provenance recording the HTTPS repository URL and immutable 40-hex commit, and no remote or mutable sources. Install performs no runtime code execution.",
  },
  {
    slug: "tutorials/first-pack",
    href: "/developers/docs/tutorials/first-pack/",
    title: "First pack tutorial",
    description:
      "Create, validate, pin, install, activate, and pin to an event — one minimal pack end to end.",
    maturity: "stable",
    section: "Tutorials",
    headings: [
      { id: "scaffold", text: "Scaffold a pack" },
      { id: "validate", text: "Validate a pack" },
      { id: "pin", text: "Pin an immutable Git revision" },
      { id: "install", text: "Install a pack" },
      { id: "activate", text: "Activate for a tenant" },
      { id: "common-failures", text: "Common failures and diagnostic codes" },
      { id: "teardown", text: "Teardown and remove" },
    ],
    body: "First pack tutorial: from an empty directory, scaffold a problem pack with pack init, validate it offline with pack validate, pin an immutable full 40-hex Git commit revision, install it with pack install, activate it for a tenant with pack activate, create an event that pins the catalog snapshot, verify it in the organizer console, and tear it down with pack deactivate and pack remove. Uses one minimal pack com.example.starter with the hello-world problem. Common validator failures map to exact diagnostic codes such as PACK_DIR_MISSING, MANIFEST_MISSING, MANIFEST_INVALID, DUPLICATE_PROBLEM_ID, ARTIFACT_MISSING, and RUNTIME_MISMATCH. Every command runs fully offline with no cloud credentials until the final platform deploy step.",
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
