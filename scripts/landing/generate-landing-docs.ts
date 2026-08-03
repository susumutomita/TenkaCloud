/**
 * Issue #2433: developer docs on the landing, in the landing design.
 *
 * tenkacloud.com serves the hand-built static `landing/` (the design canon).
 * The developer docs' single source of truth is the portal's MDX
 * (apps/developer-portal/src/app/developers/docs/xx/page.mdx) plus the generated
 * REFERENCE_DATA tables. This script renders those into static, landing-styled
 * pages under `landing/docs/` — the same committed-artifact + `--check` drift
 * guard pattern as scripts/landing/generate-landing-locales.ts.
 *
 * MDX handling is deliberately minimal (the docs are ~pure markdown):
 *   - `import …` lines are dropped
 *   - `export const metadata = { title: "…" }` supplies the page title, then the
 *     line is dropped
 *   - `<MaturityBadge level="x" />` becomes a static badge span
 *   - `<XxxTable />` / `<ProvenanceFactList />` render REFERENCE_DATA to HTML,
 *     mirroring apps/developer-portal/src/components/ReferenceTables.tsx
 *   - internal `/developers/docs/**` links are rewritten to `/docs/**`; other
 *     portal-only routes (API reference, examples) point at the GitHub repo
 * Anything else that looks like JSX fails the build loudly rather than
 * shipping a broken page.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { marked } from "marked";
import { DOC_PAGES } from "../../apps/developer-portal/src/content/docs-registry";
import { REFERENCE_DATA } from "../../apps/developer-portal/src/content/reference-data";
import { MATURITY_LABELS, type Maturity } from "../../apps/developer-portal/src/lib/maturity";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const MDX_ROOT = join(REPO_ROOT, "apps/developer-portal/src/app/developers/docs");
const OUT_ROOT = join(REPO_ROOT, "landing/docs");
const PUBLIC_DOCS_ROOT = join(REPO_ROOT, "apps/developer-portal/public/docs");
const GITHUB_REPO = "https://github.com/susumutomita/TenkaCloud";
const SITE_ORIGIN = "https://tenkacloud.com";
const DOC_ASSETS = [
  "assets/problem-author-flow.ja.svg",
  "assets/problem-author-flow.en.svg",
] as const;

/**
 * Locale model mirrors the hand-built landing: the path root serves Japanese
 * (`index.html`) and English lives beside it as `index.en.html`. Every docs
 * page therefore needs BOTH sources: `page.mdx` (en) and `page.ja.mdx` (ja) —
 * a missing translation fails the build loudly (no silent single-language
 * fallback).
 */
type Locale = "ja" | "en";
const LOCALES: readonly Locale[] = ["ja", "en"];

interface DocPage {
  readonly slug: string; // path under /docs/, no leading/trailing slash
  readonly mdx: string; // path under MDX_ROOT
}

interface DocSection {
  readonly title: string;
  readonly jaTitle: string;
  readonly pages: readonly DocPage[];
}

// Order defines the sidebar. Every page.mdx under the portal docs tree must be
// listed here — main() fails loudly on drift so new docs can't silently vanish.
const SECTIONS: readonly DocSection[] = [
  {
    title: "Role manuals",
    jaTitle: "役割別マニュアル",
    pages: [
      { slug: "manual", mdx: "manual/page.mdx" },
      { slug: "manual/developer", mdx: "manual/developer/page.mdx" },
      { slug: "manual/organizer", mdx: "manual/organizer/page.mdx" },
      { slug: "manual/participant", mdx: "manual/participant/page.mdx" },
      { slug: "manual/problem-author", mdx: "manual/problem-author/page.mdx" },
    ],
  },
  {
    title: "Getting started",
    jaTitle: "はじめに",
    pages: [{ slug: "getting-started", mdx: "getting-started/page.mdx" }],
  },
  {
    title: "Concepts",
    jaTitle: "コンセプト",
    pages: [
      { slug: "concepts/problem-packs", mdx: "concepts/problem-packs/page.mdx" },
      { slug: "concepts/architecture", mdx: "concepts/architecture/page.mdx" },
    ],
  },
  {
    title: "Tutorials",
    jaTitle: "チュートリアル",
    pages: [{ slug: "tutorials/first-pack", mdx: "tutorials/first-pack/page.mdx" }],
  },
  {
    title: "Operate",
    jaTitle: "運用",
    pages: [
      { slug: "operate/deploy-paths", mdx: "operate/deploy-paths/page.mdx" },
      { slug: "operate/run-an-event", mdx: "operate/run-an-event/page.mdx" },
      { slug: "operate/use-existing-pack", mdx: "operate/use-existing-pack/page.mdx" },
    ],
  },
  {
    title: "Reference",
    jaTitle: "リファレンス",
    pages: [
      { slug: "reference/pack-manifest", mdx: "reference/pack-manifest/page.mdx" },
      { slug: "reference/problem-metadata", mdx: "reference/problem-metadata/page.mdx" },
      { slug: "reference/runtime-matrix", mdx: "reference/runtime-matrix/page.mdx" },
      { slug: "reference/cli", mdx: "reference/cli/page.mdx" },
      {
        slug: "reference/onboarding-analytics",
        mdx: "reference/onboarding-analytics/page.mdx",
      },
      { slug: "reference/lite-settings", mdx: "reference/lite-settings/page.mdx" },
      { slug: "reference/lite-messages", mdx: "reference/lite-messages/page.mdx" },
      { slug: "reference/security-provenance", mdx: "reference/security-provenance/page.mdx" },
      { slug: "reference/validation-errors", mdx: "reference/validation-errors/page.mdx" },
    ],
  },
];

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function badge(level: Maturity): string {
  return `<span class="doc-badge doc-badge--${level}">${escapeHtml(MATURITY_LABELS[level])}</span>`;
}

// --- REFERENCE_DATA renderers (mirror ReferenceTables.tsx column-for-column) ---

function requiredLabel(required: boolean): string {
  return required ? "Required" : "Optional";
}

function tableCell(cell: string): string {
  return `<td>${cell}</td>`;
}

/** Repo-relative path for operator-facing messages (absolute paths are noise in a log). */
function repoRelative(path: string): string {
  return path.replace(`${REPO_ROOT}/`, "");
}

function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const head = headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("");
  const body = rows.map((cells) => `<tr>${cells.map(tableCell).join("")}</tr>`).join("\n");
  return `<table class="reference-table"><thead><tr>${head}</tr></thead><tbody>\n${body}\n</tbody></table>`;
}

const COMPONENT_RENDERERS: Record<string, () => string> = {
  ManifestFieldTable: () =>
    table(
      ["Field", "Type", "Presence", "Constraint"],
      REFERENCE_DATA.manifestFields.map((f) => [
        `<code>${escapeHtml(f.name)}</code>`,
        `<code>${escapeHtml(f.type)}</code>`,
        requiredLabel(f.required),
        escapeHtml(f.constraint),
      ]),
    ),
  MetadataFieldTable: () =>
    table(
      ["Field", "Type", "Presence", "Description"],
      REFERENCE_DATA.metadataFields.map((f) => [
        `<code>${escapeHtml(f.name)}</code>`,
        `<code>${escapeHtml(f.type)}</code>`,
        requiredLabel(f.required),
        escapeHtml(f.description),
      ]),
    ),
  RuntimeMatrixTable: () =>
    table(
      [
        "Provider",
        "Engine",
        "Mode",
        "Recognized",
        "Adapter wired",
        "Executable",
        "Live verified",
        "Maturity",
        "Blocking issues",
        "Evidence",
      ],
      REFERENCE_DATA.runtimeMatrix.map((r) => [
        `<code>${escapeHtml(r.provider)}</code>`,
        `<code>${escapeHtml(r.engine)}</code>`,
        escapeHtml(r.executionMode),
        r.recognized ? "yes" : "no",
        r.adapterWired ? "yes" : "no",
        r.executable ? "yes" : "no",
        r.liveVerified ? "yes" : "no",
        badge(r.maturity),
        r.blockingIssues.length === 0
          ? "—"
          : r.blockingIssues
              .map((issue) => `<a href="${GITHUB_REPO}/issues/${issue}">#${issue}</a>`)
              .join(", "),
        escapeHtml(r.evidence),
      ]),
    ),
  CliCommandTable: () =>
    table(
      ["Command", "Usage"],
      REFERENCE_DATA.cliCommands.map((c) => [
        `<code>${escapeHtml(c.name)}</code>`,
        `<code>${escapeHtml(c.usage)}</code>`,
      ]),
    ),
  ValidationErrorTable: () =>
    table(
      ["Code", "What it means / how to fix it"],
      REFERENCE_DATA.validationErrors.map((e) => [
        `<code>${escapeHtml(e.code)}</code>`,
        escapeHtml(e.explanation),
      ]),
    ),
  ProvenanceFactList: () =>
    `<dl class="reference-facts">\n${REFERENCE_DATA.provenanceFacts
      .map(
        (f) =>
          `<div><dt>${escapeHtml(f.title)} ${badge(f.maturity)}</dt><dd>${escapeHtml(f.detail)}</dd></div>`,
      )
      .join("\n")}\n</dl>`,
};

// --- MDX → markdown-with-inline-HTML ---

function transformMdx(
  source: string,
  mdxPath: string,
  locale: Locale,
): { title: string; markdown: string } {
  let title = "";
  const kept: string[] = [];
  for (const line of source.split("\n")) {
    if (/^import\s/.test(line)) continue;
    const meta = /^export const metadata = \{ title: "([^"]+)" \};?$/.exec(line);
    if (meta) {
      title = meta[1];
      continue;
    }
    if (/^export\s/.test(line)) {
      throw new Error(`${mdxPath}: unsupported export line: ${line}`);
    }
    kept.push(line);
  }
  let markdown = kept.join("\n");

  markdown = markdown.replace(/<MaturityBadge level="([a-z]+)"\s*\/>/g, (_m, level: string) =>
    badge(level as Maturity),
  );
  markdown = markdown.replace(/<([A-Z][A-Za-z]*)\s*\/>/g, (_m, name: string) => {
    const render = COMPONENT_RENDERERS[name];
    if (!render) {
      throw new Error(`${mdxPath}: no renderer for component <${name} />`);
    }
    return render();
  });
  const leftover = /<[A-Z][A-Za-z]*[\s>/]/.exec(markdown);
  if (leftover) {
    throw new Error(`${mdxPath}: unhandled JSX remains: ${leftover[0]}`);
  }

  // Internal links: docs stay on the landing (same locale); portal-only
  // surfaces go to GitHub. English pages must link the .en variants, or one
  // click would silently switch the reader to Japanese.
  markdown = markdown.replace(
    /\]\(\/developers\/docs\/([^)#?]*?)\/?([#?][^)]*)?\)/g,
    (_m, path: string, hash: string | undefined) =>
      `](${docsUrl(path.length > 0 ? path : null, locale)}${hash ?? ""})`,
  );
  markdown = markdown.replaceAll("](/developers/api/", `](${GITHUB_REPO}#readme`);
  markdown = markdown.replaceAll("](/developers/examples/", `](${GITHUB_REPO}#readme`);
  markdown = markdown.replaceAll("](/developers/", `](${GITHUB_REPO}#readme`);

  if (!title) {
    throw new Error(`${mdxPath}: no metadata title found`);
  }
  return { title, markdown };
}

// --- landing-chrome template (same lightweight pattern as landing/privacy.html) ---

const GITHUB_MARK = `<svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.67 0 8.2c0 3.62 2.29 6.69 5.47 7.78.4.08.55-.18.55-.4 0-.2-.01-.86-.01-1.56-2.01.38-2.53-.5-2.69-.96-.09-.24-.48-.96-.82-1.15-.28-.15-.68-.53-.01-.54.63-.01 1.08.59 1.23.84.72 1.24 1.87.89 2.33.68.07-.53.28-.89.51-1.09-1.78-.21-3.64-.91-3.64-4.04 0-.89.31-1.62.82-2.19-.08-.21-.36-1.04.08-2.16 0 0 .67-.22 2.2.84A7.34 7.34 0 0 1 8 3.98c.68 0 1.36.09 2 .27 1.53-1.06 2.2-.84 2.2-.84.44 1.12.16 1.95.08 2.16.51.57.82 1.3.82 2.19 0 3.14-1.87 3.83-3.65 4.04.29.26.54.75.54 1.51 0 1.09-.01 1.96-.01 2.23 0 .22.15.48.55.4A8.16 8.16 0 0 0 16 8.2C16 3.67 12.42 0 8 0Z"/></svg>`;

const BRAND_MARK = `<svg viewBox="0 0 120 120" width="1.05em" height="1.05em" aria-hidden="true" style="display:block;flex:none"><rect x="26" y="24" width="68" height="12" rx="6" fill="currentColor"></rect><path d="M26 90 L60 48 L94 90" fill="none" stroke="currentColor" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"></path></svg>`;

function docsUrl(slug: string | null, locale: Locale): string {
  const base = slug ? `/docs/${slug}/` : "/docs/";
  return locale === "en" ? `${base}index.en.html` : base;
}

function outPath(slug: string | null, locale: Locale): string {
  const file = locale === "en" ? "index.en.html" : "index.html";
  return slug ? join(OUT_ROOT, slug, file) : join(OUT_ROOT, file);
}

/** Per-locale UI chrome strings (the article body comes from the MDX). */
const CHROME = {
  ja: {
    home: "ホーム",
    homeHref: "/",
    backHome: "← ホーム",
    docsHome: "Docs ホーム",
    docsSuffix: "TenkaCloud Docs",
  },
  en: {
    home: "Home",
    homeHref: "/index.en.html",
    backHome: "← Home",
    docsHome: "Docs home",
    docsSuffix: "TenkaCloud Docs",
  },
} as const;

function sidebar(currentSlug: string | null, locale: Locale): string {
  const chrome = CHROME[locale];
  const sections = SECTIONS.map((section) => {
    const links = section.pages
      .map((page) => {
        const current = page.slug === currentSlug ? ' aria-current="page"' : "";
        const label = escapeHtml(pageTitle(page, locale));
        return `<li><a href="${docsUrl(page.slug, locale)}"${current}>${label}</a></li>`;
      })
      .join("\n");
    const title = locale === "ja" ? section.jaTitle : section.title;
    return `<section><h5>${escapeHtml(title)}</h5><ul>\n${links}\n</ul></section>`;
  }).join("\n");
  return `<aside class="docs-nav"><a class="docs-home-link" href="${docsUrl(null, locale)}">${chrome.docsHome}</a>\n${sections}\n</aside>`;
}

const titleCache = new Map<string, string>();

function mdxPathFor(page: DocPage, locale: Locale): string {
  return locale === "ja" ? page.mdx.replace(/page\.mdx$/, "page.ja.mdx") : page.mdx;
}

function readMdxSource(page: DocPage, locale: Locale): string {
  const path = join(MDX_ROOT, mdxPathFor(page, locale));
  if (!existsSync(path)) {
    throw new Error(
      `missing ${locale} source for /docs/${page.slug}/ — expected ${mdxPathFor(page, locale)} (every docs page needs page.mdx AND page.ja.mdx)`,
    );
  }
  return readFileSync(path, "utf8");
}

function pageTitle(page: DocPage, locale: Locale): string {
  const key = `${locale}:${page.slug}`;
  const cached = titleCache.get(key);
  if (cached) return cached;
  const source = readMdxSource(page, locale);
  const meta = /^export const metadata = \{ title: "([^"]+)" \};?$/m.exec(source);
  const title = meta ? meta[1] : page.slug;
  titleCache.set(key, title);
  return title;
}

function shell(args: {
  title: string;
  slug: string | null;
  article: string;
  locale: Locale;
}): string {
  const chrome = CHROME[args.locale];
  const jaUrl = docsUrl(args.slug, "ja");
  const enUrl = docsUrl(args.slug, "en");
  return `<!doctype html>
<!-- Generated by scripts/landing/generate-landing-docs.ts — do not edit by hand.
     Source: apps/developer-portal/src/app/developers/docs/ (single source of truth). -->
<html lang="${args.locale}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(args.title)} — ${chrome.docsSuffix}</title>
<link rel="canonical" href="${SITE_ORIGIN}${args.locale === "ja" ? jaUrl : enUrl}" />
<link rel="alternate" hreflang="ja" href="${SITE_ORIGIN}${jaUrl}" />
<link rel="alternate" hreflang="en" href="${SITE_ORIGIN}${enUrl}" />
<link rel="icon" type="image/svg+xml" href="/assets/favicon.svg" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Noto+Sans+JP:wght@300;400;500;700&family=JetBrains+Mono:wght@400;500&display=swap" />
<link rel="stylesheet" href="/styles/docs.css" />
</head>
<body>
<header class="top">
  <div class="wrap top-inner">
    <a class="brand" href="${chrome.homeHref}">${BRAND_MARK}TenkaCloud <span class="brand-docs">Docs</span></a>
    <div class="top-right">
      <span class="top-links"><a href="${chrome.homeHref}">${chrome.backHome}</a></span>
      <div class="lang-switch" role="group" aria-label="Language">
        <a class="lang${args.locale === "ja" ? " on" : ""}" href="${jaUrl}" hreflang="ja"${args.locale === "ja" ? ' aria-current="page"' : ""}>日本語</a>
        <a class="lang${args.locale === "en" ? " on" : ""}" href="${enUrl}" hreflang="en"${args.locale === "en" ? ' aria-current="page"' : ""}>English</a>
      </div>
      <a class="github-mark" href="${GITHUB_REPO}" target="_blank" rel="noopener noreferrer" aria-label="GitHub">${GITHUB_MARK}</a>
    </div>
  </div>
</header>
<div class="wrap docs-grid">
${sidebar(args.slug, args.locale)}
<main class="doc">
${args.article}
</main>
</div>
<footer class="docs-footer">
  <div class="wrap">© 2026 合同会社BULL · TenkaCloud · Apache License 2.0 · <a href="${docsUrl(null, args.locale)}">${chrome.docsHome}</a> · <a href="${chrome.homeHref}">${chrome.home}</a></div>
</footer>
</body>
</html>
`;
}

const HOME_COPY = {
  ja: {
    title: "TenkaCloud ドキュメント",
    lede: `開発者・競技開催者・競技参加者・問題作成者の4つの役割から、今日行う作業に合うマニュアルを選べます。まず「役割から選ぶマニュアル」を開いてください。ソースは <a href="${GITHUB_REPO}" target="_blank" rel="noopener noreferrer">GitHub</a> のリポジトリと同期しています。`,
  },
  en: {
    title: "TenkaCloud documentation",
    lede: `Choose the manual for the work you are doing today: developer, competition organizer, competition participant, or problem author. Start with “Manuals by role.” The source is kept in sync with the <a href="${GITHUB_REPO}" target="_blank" rel="noopener noreferrer">GitHub</a> repository.`,
  },
} as const;

function docsHome(locale: Locale): string {
  const cards = SECTIONS.map((section) => {
    const links = section.pages
      .map(
        (page) =>
          `<li><a href="${docsUrl(page.slug, locale)}">${escapeHtml(pageTitle(page, locale))}</a></li>`,
      )
      .join("\n");
    const title = locale === "ja" ? section.jaTitle : section.title;
    return `<section class="docs-card"><h2>${escapeHtml(title)}</h2><ul>\n${links}\n</ul></section>`;
  }).join("\n");
  const copy = HOME_COPY[locale];
  const article = `<h1>${escapeHtml(copy.title)}</h1>
<p class="lede">${copy.lede}</p>
<div class="docs-cards">
${cards}
</div>`;
  return shell({ title: copy.title, slug: null, article, locale });
}

async function renderPage(page: DocPage, locale: Locale): Promise<string> {
  const source = readMdxSource(page, locale);
  const { title, markdown } = transformMdx(source, mdxPathFor(page, locale), locale);
  const body = await marked.parse(markdown, { gfm: true, async: true });
  return shell({ title, slug: page.slug, article: `<article>\n${body}\n</article>`, locale });
}

/**
 * The portal's docs-registry (its sidebar/search source of truth) and this
 * generator's SECTIONS must list the same pages — this is the loud drift guard
 * that was previously only a comment (operate/use-existing-pack had already
 * fallen through the gap).
 */
function assertRegistryParity(): void {
  const registry = new Set(DOC_PAGES.map((page) => page.slug));
  const sections = new Set(SECTIONS.flatMap((section) => section.pages.map((page) => page.slug)));
  const missing = [...registry].filter((slug) => !sections.has(slug));
  const extra = [...sections].filter((slug) => !registry.has(slug));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `docs page drift vs docs-registry.ts — missing from generator: [${missing.join(", ")}], not in registry: [${extra.join(", ")}]`,
    );
  }
}

async function generate(): Promise<Map<string, string>> {
  assertRegistryParity();
  const files = new Map<string, string>();
  for (const asset of DOC_ASSETS) {
    const sourcePath = join(PUBLIC_DOCS_ROOT, asset);
    if (!existsSync(sourcePath)) {
      throw new Error(`missing docs asset: ${repoRelative(sourcePath)}`);
    }
    files.set(join(OUT_ROOT, asset), readFileSync(sourcePath, "utf8"));
  }
  for (const locale of LOCALES) {
    files.set(outPath(null, locale), docsHome(locale));
    for (const section of SECTIONS) {
      for (const page of section.pages) {
        files.set(outPath(page.slug, locale), await renderPage(page, locale));
      }
    }
  }
  return files;
}

async function main(): Promise<void> {
  const check = process.argv.includes("--check");
  const files = await generate();
  let drift = 0;
  for (const [path, content] of files) {
    if (check) {
      const current = existsSync(path) ? readFileSync(path, "utf8") : "";
      if (current !== content) {
        console.error(`stale: ${repoRelative(path)}`);
        drift += 1;
      }
    } else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    }
  }
  if (check && drift > 0) {
    console.error(
      `landing/docs is stale (${drift} file(s)); run: bun run scripts/landing/generate-landing-docs.ts`,
    );
    process.exit(1);
  }
  console.log(
    check
      ? `landing/docs is up to date (${files.size} files).`
      : `wrote ${files.size} files under landing/docs/.`,
  );
}

await main();
