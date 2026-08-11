import { DOC_PAGES } from "@/content/docs-registry";
import { listApiOperations } from "@/content/openapi";

// One command-search index spans MDX docs (titles,
// headings, body) and the OpenAPI operation list, so a developer searches docs and
// endpoints from one box. This is the single source feeding the command palette on
// every route, which is what makes search behave identically across surfaces.

export type SearchKind = "doc" | "heading" | "api";

export interface SearchEntry {
  readonly id: string;
  readonly kind: SearchKind;
  readonly title: string;
  readonly href: string;
  // Lowercased haystack the query is matched against.
  readonly haystack: string;
  readonly badge?: string;
}

export function buildSearchIndex(): readonly SearchEntry[] {
  const entries: SearchEntry[] = [];

  for (const page of DOC_PAGES) {
    entries.push({
      id: `doc:${page.slug}`,
      kind: "doc",
      title: page.title,
      href: page.href,
      haystack: `${page.title} ${page.description} ${page.body}`.toLowerCase(),
      badge: "Docs",
    });
    for (const heading of page.headings) {
      entries.push({
        id: `heading:${page.slug}#${heading.id}`,
        kind: "heading",
        title: `${heading.text} — ${page.title}`,
        href: `${page.href}#${heading.id}`,
        haystack: heading.text.toLowerCase(),
        badge: "Docs",
      });
    }
  }

  for (const op of listApiOperations()) {
    entries.push({
      id: `api:${op.operationId}`,
      kind: "api",
      title: `${op.method} ${op.path}`,
      href: `/developers/api/#${op.operationId}`,
      haystack: `${op.operationId} ${op.method} ${op.path} ${op.summary}`.toLowerCase(),
      badge: "API",
    });
  }

  return entries;
}

export function searchIndex(query: string, index = buildSearchIndex()): readonly SearchEntry[] {
  const trimmed = query.trim().toLowerCase();
  if (trimmed.length === 0) {
    return [];
  }
  const terms = trimmed.split(/\s+/);
  return index.filter((entry) => terms.every((term) => entry.haystack.includes(term)));
}
