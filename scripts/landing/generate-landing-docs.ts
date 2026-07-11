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
import { REFERENCE_DATA } from "../../apps/developer-portal/src/content/reference-data";
import { MATURITY_LABELS, type Maturity } from "../../apps/developer-portal/src/lib/maturity";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const MDX_ROOT = join(REPO_ROOT, "apps/developer-portal/src/app/developers/docs");
const OUT_ROOT = join(REPO_ROOT, "landing/docs");
const GITHUB_REPO = "https://github.com/susumutomita/TenkaCloud";

interface DocPage {
  readonly slug: string; // path under /docs/, no leading/trailing slash
  readonly mdx: string; // path under MDX_ROOT
}

interface DocSection {
  readonly title: string;
  readonly pages: readonly DocPage[];
}

// Order defines the sidebar. Every page.mdx under the portal docs tree must be
// listed here — main() fails loudly on drift so new docs can't silently vanish.
const SECTIONS: readonly DocSection[] = [
  {
    title: "Getting started",
    pages: [{ slug: "getting-started", mdx: "getting-started/page.mdx" }],
  },
  {
    title: "Concepts",
    pages: [
      { slug: "concepts/problem-packs", mdx: "concepts/problem-packs/page.mdx" },
      { slug: "concepts/architecture", mdx: "concepts/architecture/page.mdx" },
    ],
  },
  {
    title: "Tutorials",
    pages: [{ slug: "tutorials/first-pack", mdx: "tutorials/first-pack/page.mdx" }],
  },
  {
    title: "Operate",
    pages: [
      { slug: "operate/deploy-paths", mdx: "operate/deploy-paths/page.mdx" },
      { slug: "operate/run-an-event", mdx: "operate/run-an-event/page.mdx" },
    ],
  },
  {
    title: "Reference",
    pages: [
      { slug: "reference/pack-manifest", mdx: "reference/pack-manifest/page.mdx" },
      { slug: "reference/problem-metadata", mdx: "reference/problem-metadata/page.mdx" },
      { slug: "reference/runtime-matrix", mdx: "reference/runtime-matrix/page.mdx" },
      { slug: "reference/cli", mdx: "reference/cli/page.mdx" },
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

function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const head = headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("");
  const body = rows
    .map((cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`)
    .join("\n");
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
      ["Provider", "Engine", "Support", "Maturity", "Notes"],
      REFERENCE_DATA.runtimeMatrix.map((r) => [
        `<code>${escapeHtml(r.provider)}</code>`,
        `<code>${escapeHtml(r.engine)}</code>`,
        escapeHtml(r.support),
        badge(r.maturity),
        escapeHtml(r.note),
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

function transformMdx(source: string, mdxPath: string): { title: string; markdown: string } {
  let title = "";
  const kept: string[] = [];
  for (const line of source.split("\n")) {
    if (/^import\s/.test(line)) continue;
    const meta = line.match(/^export const metadata = \{ title: "([^"]+)" \};?$/);
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
  const leftover = markdown.match(/<[A-Z][A-Za-z]*[\s>/]/);
  if (leftover) {
    throw new Error(`${mdxPath}: unhandled JSX remains: ${leftover[0]}`);
  }

  // Internal links: docs stay on the landing; portal-only surfaces go to GitHub.
  markdown = markdown.replaceAll("](/developers/docs/", "](/docs/");
  markdown = markdown.replaceAll("](/developers/api/", `](${GITHUB_REPO}#readme`);
  markdown = markdown.replaceAll("](/developers/examples/", `](${GITHUB_REPO}#readme`);
  markdown = markdown.replaceAll("](/developers/", `](${GITHUB_REPO}#readme`);

  if (!title) {
    throw new Error(`${mdxPath}: no metadata title found`);
  }
  return { title, markdown };
}

// --- landing-chrome template (same lightweight pattern as landing/privacy.html) ---

const BRAND_MARK = `<svg viewBox="0 0 120 120" width="1.05em" height="1.05em" aria-hidden="true" style="display:block;flex:none"><rect x="26" y="24" width="68" height="12" rx="6" fill="currentColor"></rect><path d="M26 90 L60 48 L94 90" fill="none" stroke="currentColor" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"></path></svg>`;

function sidebar(currentSlug: string | null): string {
  const sections = SECTIONS.map((section) => {
    const links = section.pages
      .map((page) => {
        const current = page.slug === currentSlug ? ' aria-current="page"' : "";
        const label = escapeHtml(pageTitle(page));
        return `<li><a href="/docs/${page.slug}/"${current}>${label}</a></li>`;
      })
      .join("\n");
    return `<section><h5>${escapeHtml(section.title)}</h5><ul>\n${links}\n</ul></section>`;
  }).join("\n");
  return `<aside class="docs-nav"><a class="docs-home-link" href="/docs/">Docs home</a>\n${sections}\n</aside>`;
}

const titleCache = new Map<string, string>();

function pageTitle(page: DocPage): string {
  const cached = titleCache.get(page.slug);
  if (cached) return cached;
  const source = readFileSync(join(MDX_ROOT, page.mdx), "utf8");
  const meta = source.match(/^export const metadata = \{ title: "([^"]+)" \};?$/m);
  const title = meta ? meta[1] : page.slug;
  titleCache.set(page.slug, title);
  return title;
}

function shell(args: { title: string; slug: string | null; article: string }): string {
  return `<!doctype html>
<!-- Generated by scripts/landing/generate-landing-docs.ts — do not edit by hand.
     Source: apps/developer-portal/src/app/developers/docs/ (single source of truth). -->
<html lang="ja">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(args.title)} — TenkaCloud Docs</title>
<link rel="icon" type="image/svg+xml" href="/assets/favicon.svg" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Noto+Sans+JP:wght@300;400;500;700&family=JetBrains+Mono:wght@400;500&display=swap" />
<link rel="stylesheet" href="/styles/docs.css" />
</head>
<body>
<header class="top">
  <div class="wrap top-inner">
    <a class="brand" href="/">${BRAND_MARK}TenkaCloud <span class="brand-docs">Docs</span></a>
    <span class="top-links"><a href="/">← ホーム</a> · <a href="${GITHUB_REPO}" target="_blank" rel="noopener noreferrer">GitHub</a></span>
  </div>
</header>
<div class="wrap docs-grid">
${sidebar(args.slug)}
<main class="doc">
${args.article}
</main>
</div>
<footer class="docs-footer">
  <div class="wrap">© 2026 合同会社BULL · TenkaCloud · Apache License 2.0 · <a href="/docs/">Docs home</a> · <a href="/">ホーム</a></div>
</footer>
</body>
</html>
`;
}

function docsHome(): string {
  const cards = SECTIONS.map((section) => {
    const links = section.pages
      .map((page) => `<li><a href="/docs/${page.slug}/">${escapeHtml(pageTitle(page))}</a></li>`)
      .join("\n");
    return `<section class="docs-card"><h2>${escapeHtml(section.title)}</h2><ul>\n${links}\n</ul></section>`;
  }).join("\n");
  const article = `<h1>Developer docs</h1>
<p class="lede">問題パックの作成から、イベント運営、スキーマ / CLI リファレンスまで。ソースは <a href="${GITHUB_REPO}" target="_blank" rel="noopener noreferrer">GitHub</a> のリポジトリと同期しています。API reference と examples は当面 GitHub 側を参照してください。</p>
<div class="docs-cards">
${cards}
</div>`;
  return shell({ title: "Developer docs", slug: null, article });
}

async function renderPage(page: DocPage): Promise<string> {
  const source = readFileSync(join(MDX_ROOT, page.mdx), "utf8");
  const { title, markdown } = transformMdx(source, page.mdx);
  const body = await marked.parse(markdown, { gfm: true, async: true });
  return shell({ title, slug: page.slug, article: `<article>\n${body}\n</article>` });
}

async function generate(): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  files.set(join(OUT_ROOT, "index.html"), docsHome());
  for (const section of SECTIONS) {
    for (const page of section.pages) {
      files.set(join(OUT_ROOT, page.slug, "index.html"), await renderPage(page));
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
        console.error(`stale: ${path.replace(`${REPO_ROOT}/`, "")}`);
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
