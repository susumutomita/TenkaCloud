#!/usr/bin/env tsx
/**
 * [Issue #2408] Public problem-catalog data generator + drift check.
 *
 * The public catalog page (/catalog, /en/catalog) is GENERATED from the single
 * source of truth: the per-problem `metadata.json` files in the `problems/`
 * submodule (the TenkaCloudChallenge catalog). This script
 * reads every `problems/<category>/<id>/metadata.json`, keeps the publicly
 * visible ones, and emits one typed, committed data module
 * (`src/content/catalog-data.ts`) that the catalog page renders.
 *
 * Why a COMMITTED artifact (not a build-time read):
 *   - The developer portal is a static export deployed on Cloudflare Pages, whose
 *     build must not depend on the `problems/` submodule being checked out. By
 *     committing the generated module, the page builds with zero submodule
 *     dependency (matching how the docs reference is generated + committed).
 *   - The submodule pin is bumped by a manually-opened PR (`make submodule-latest`;
 *     there is no automated bump workflow). A hard byte-equality CI gate coupled
 *     to the pin would therefore surprise unrelated PRs after a bump, so
 *     the drift check here is a MAINTAINER tool (`--check`), not a CI gate. Run
 *     `bun run generate:catalog` after the catalog changes and commit the result.
 *
 * `--check` mode regenerates in memory and exits non-zero when the committed
 * module is stale vs the current submodule metadata. It requires the submodule to
 * be checked out (`git submodule update --init problems`).
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CatalogCategory,
  CatalogData,
  CatalogProblem,
  CatalogStatus,
} from "../src/content/catalog-data";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "..", "..", "..");
const PROBLEMS_DIR = resolve(REPO_ROOT, "problems");
const OUTPUT_PATH = resolve(here, "..", "src", "content", "catalog-data.ts");

// The two catalog category directories in the submodule (problem metadata layout).
const CATEGORY_DIRS = ["battles", "challenges"] as const;

const VALID_CATEGORIES: readonly CatalogCategory[] = ["Battle", "Challenge"];
const VALID_STATUSES: readonly CatalogStatus[] = ["ready", "draft", "deprecated"];

// The raw metadata.json fields this generator reads. Everything else in the file
// (scoring, disruptions, template refs, etc.) is intentionally ignored — the
// public catalog surface is display-only.
interface RawMetadata {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly category?: unknown;
  readonly status?: unknown;
  readonly visibility?: unknown;
  readonly difficulty?: unknown;
  readonly tags?: unknown;
  readonly i18n?: { readonly en?: { readonly name?: unknown } };
}

function isMetadataFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

/** Every `problems/<category>/<id>/metadata.json` under the checked-out submodule. */
function collectMetadataFiles(): string[] {
  const files: string[] = [];
  for (const categoryDir of CATEGORY_DIRS) {
    const dir = join(PROBLEMS_DIR, categoryDir);
    if (!existsSync(dir)) {
      continue;
    }
    for (const entry of readdirSync(dir)) {
      const metadataPath = join(dir, entry, "metadata.json");
      if (isMetadataFile(metadataPath)) {
        files.push(metadataPath);
      }
    }
  }
  return files.sort();
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function toProblem(path: string): CatalogProblem | undefined {
  const raw = JSON.parse(readFileSync(path, "utf8")) as RawMetadata;

  // Only publicly visible problems appear on the outward-facing catalog.
  if (raw.visibility !== "public") {
    return undefined;
  }
  const id = asString(raw.id);
  const category = asString(raw.category);
  const status = asString(raw.status);
  const nameJa = asString(raw.name);
  if (
    id === undefined ||
    nameJa === undefined ||
    category === undefined ||
    !VALID_CATEGORIES.includes(category as CatalogCategory)
  ) {
    return undefined;
  }
  const normalizedStatus: CatalogStatus =
    status !== undefined && VALID_STATUSES.includes(status as CatalogStatus)
      ? (status as CatalogStatus)
      : "draft";
  const difficulty =
    typeof raw.difficulty === "number" && Number.isFinite(raw.difficulty)
      ? Math.min(5, Math.max(1, Math.round(raw.difficulty)))
      : 1;
  const tags = Array.isArray(raw.tags)
    ? raw.tags.filter((tag): tag is string => typeof tag === "string").slice(0, 4)
    : [];
  // EN name falls back to the JA (top-level) name when a problem ships no i18n.en
  // override — the catalog stays bilingual-complete rather than dropping a card.
  const nameEn = asString(raw.i18n?.en?.name) ?? nameJa;

  return {
    id,
    category: category as CatalogCategory,
    status: normalizedStatus,
    difficulty,
    tags,
    name: { ja: nameJa, en: nameEn },
  };
}

// Deterministic order: Battle before Challenge, then ready before draft before
// deprecated, then easier first, then id — so the generated module is stable.
const CATEGORY_ORDER: Record<CatalogCategory, number> = { Battle: 0, Challenge: 1 };
const STATUS_ORDER: Record<CatalogStatus, number> = { ready: 0, draft: 1, deprecated: 2 };

function sortProblems(problems: CatalogProblem[]): CatalogProblem[] {
  return problems.sort((a, b) => {
    if (a.category !== b.category) return CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category];
    if (a.status !== b.status) return STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (a.difficulty !== b.difficulty) return a.difficulty - b.difficulty;
    return a.id.localeCompare(b.id);
  });
}

export function buildCatalogData(): CatalogData {
  const files = collectMetadataFiles();
  if (files.length === 0) {
    throw new Error(
      `No problem metadata found under ${PROBLEMS_DIR}. ` +
        "Run 'git submodule update --init problems' before regenerating the catalog.",
    );
  }
  const problems: CatalogProblem[] = [];
  for (const file of files) {
    const problem = toProblem(file);
    if (problem !== undefined) {
      problems.push(problem);
    }
  }
  return { problems: sortProblems(problems) };
}

const GENERATED_HEADER = `// GENERATED FILE — do not edit by hand.
// Produced by apps/developer-portal/scripts/generate-catalog.ts from public problem
// metadata.json files in the problems/ submodule (TenkaCloudChallenge catalog).
// Run 'bun run generate:catalog' after the catalog changes and commit
// this file. 'bun run check:catalog' fails when it is stale vs the submodule
// (a maintainer check; it needs the submodule checked out).
`;

const TYPE_DECLARATIONS = `export type CatalogCategory = "Battle" | "Challenge";
export type CatalogStatus = "ready" | "draft" | "deprecated";

export interface CatalogLocalizedText {
  readonly ja: string;
  readonly en: string;
}

export interface CatalogProblem {
  readonly id: string;
  readonly category: CatalogCategory;
  readonly status: CatalogStatus;
  readonly difficulty: number;
  readonly tags: readonly string[];
  readonly name: CatalogLocalizedText;
}

export interface CatalogData {
  readonly problems: readonly CatalogProblem[];
}
`;

/**
 * Run the committed Biome formatter over generated text so the output is
 * byte-identical to what `biome check` expects. Both write and `--check` go
 * through this, so the drift comparison never flaps on formatting.
 */
function formatWithBiome(source: string): string {
  return execFileSync("bunx", ["biome", "format", "--stdin-file-path=catalog-data.ts"], {
    cwd: REPO_ROOT,
    input: source,
    encoding: "utf8",
  });
}

/** Serialize the catalog data module deterministically (stable key order). */
export function renderCatalogModule(data: CatalogData): string {
  const raw = `${GENERATED_HEADER}\n${TYPE_DECLARATIONS}\nexport const CATALOG_DATA: CatalogData = ${JSON.stringify(
    data,
    null,
    2,
  )} as const;\n`;
  return formatWithBiome(raw);
}

/** Build the full module text from the live submodule metadata. */
export function generateCatalogModule(): string {
  return renderCatalogModule(buildCatalogData());
}

function main(): void {
  const check = process.argv.includes("--check");
  const next = generateCatalogModule();
  if (check) {
    let current = "";
    try {
      current = readFileSync(OUTPUT_PATH, "utf8");
    } catch {
      console.error(`Catalog data is missing (${OUTPUT_PATH}). Run 'bun run generate:catalog'.`);
      process.exit(1);
    }
    if (current !== next) {
      console.error(
        "Catalog data is stale vs the current problems/ submodule metadata.\n" +
          "Run 'bun run generate:catalog' and commit src/content/catalog-data.ts.",
      );
      process.exit(1);
    }
    console.log("Catalog data is up to date with the problems/ submodule metadata.");
    return;
  }
  writeFileSync(OUTPUT_PATH, next);
  console.log(`Wrote ${OUTPUT_PATH}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
