#!/usr/bin/env tsx
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { allRoutes, isInternalHref, isKnownRoute, normalizeHref } from "../src/lib/routes";

// Build-time internal link checker (#2101: "Broken internal links FAIL the build").
// Runs as the developer-portal `prebuild` step. It extracts every internal href
// from the app source (TSX + MDX), and fails with a non-zero exit if any href does
// not resolve to a known route in the route set. This is what makes a dead internal
// link break the build instead of shipping.

const here = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(here, "..", "src", "app");
const PUBLIC_DIR = resolve(here, "..", "public");
const KNOWN_ROUTES = allRoutes();

// Top-level legacy redirect stubs are valid targets too (they redirect onward).
const LEGACY_ROUTES = ["/docs/", "/get-started/", "/api/", "/changelog/"];

const ALL_VALID = [...KNOWN_ROUTES, ...LEGACY_ROUTES, ...collectPublicRoutes(PUBLIC_DIR)];

export interface LinkProblem {
  readonly file: string;
  readonly href: string;
}

const HREF_PATTERNS = [
  // href="/..." and href={"/..."}
  /href=\{?["'`](\/[^"'`]*)["'`]\}?/g,
  // Markdown links [text](/path)
  /\]\((\/[^)]*)\)/g,
];

function collectFiles(dir: string, include: (name: string) => boolean = () => true): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...collectFiles(full, include));
    } else if (include(name)) {
      out.push(full);
    }
  }
  return out;
}

// Files under Next.js `public/` are served from `/`. Include them in the same
// build-time link contract so an MDX image can be checked without pretending it
// is an application route.
function collectPublicRoutes(dir: string): string[] {
  return collectFiles(dir).map((full) => `/${relative(PUBLIC_DIR, full).replaceAll("\\", "/")}`);
}

// Extracts every internal href from one file's source.
function extractInternalHrefs(source: string): string[] {
  const hrefs: string[] = [];
  for (const pattern of HREF_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null = pattern.exec(source);
    while (match !== null) {
      const href = match[1];
      if (href && isInternalHref(href)) {
        hrefs.push(href);
      }
      match = pattern.exec(source);
    }
  }
  return hrefs;
}

// An internal href is broken when it does not resolve to a known route. Pure
// in-page anchors (path === "") are skipped — they are valid relative to their page.
function isBroken(href: string, validRoutes: readonly string[]): boolean {
  return normalizeHref(href) !== "" && !isKnownRoute(href, validRoutes);
}

export function findBrokenLinks(files: string[], validRoutes: readonly string[]): LinkProblem[] {
  const problems: LinkProblem[] = [];
  for (const file of files) {
    const hrefs = extractInternalHrefs(readFileSync(file, "utf8"));
    for (const href of hrefs) {
      if (isBroken(href, validRoutes)) {
        problems.push({ file, href });
      }
    }
  }
  return problems;
}

function main(): void {
  const files = collectFiles(APP_DIR, (name) => /\.(tsx?|mdx)$/.test(name));
  const problems = findBrokenLinks(files, ALL_VALID);
  if (problems.length > 0) {
    console.error(`Broken internal links found (${problems.length}):`);
    for (const problem of problems) {
      console.error(`  ${problem.href}  <-  ${problem.file}`);
    }
    process.exit(1);
  }
  console.log(
    `Internal link check passed: ${files.length} files, ${ALL_VALID.length} known routes.`,
  );
}

// Only run when invoked directly, not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
