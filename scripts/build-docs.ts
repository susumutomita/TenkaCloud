#!/usr/bin/env bun
/**
 * docs/**\/*.md を共通 HTML テンプレに流し込んで `.html` を生成する static site builder。
 *
 * - source: `docs/<...>.md`
 * - output: `docs/<...>.html` (同じディレクトリに併置)
 *
 * ADR 系 (`docs/architecture/adr-*.html`) は **md ソースを持たない手書き HTML** で、
 * この build script は触らない (= 上書きしない、削除しない)。表現力 (mockup / SVG /
 * collapsible) を失わないため (memory feedback_design_docs_html)。
 *
 * 使い方:
 *   bun run scripts/build-docs.ts          (= make build-docs)
 *   bun run scripts/build-docs.ts --check  (out-of-sync 検出、pre-commit / CI 用)
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { marked } from "marked";

const DOCS_ROOT = resolve(import.meta.dir, "..", "docs");
const REPO_ROOT = resolve(import.meta.dir, "..");

/** 共通 HTML テンプレ。1 ファイル 1 ページ、自己完結 (= 外部 CSS / JS なし)。 */
function template({
  title,
  description,
  lang,
  canonicalUrl,
  imageUrl,
  bodyHtml,
  sourcePath,
}: {
  title: string;
  description: string;
  lang: "en" | "ja";
  canonicalUrl: string;
  imageUrl: string;
  bodyHtml: string;
  sourcePath: string;
}): string {
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<meta name="robots" content="index, follow">
<link rel="canonical" href="${escapeHtml(canonicalUrl)}">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:type" content="article">
<meta property="og:url" content="${escapeHtml(canonicalUrl)}">
<meta property="og:site_name" content="TenkaCloud">
<meta property="og:locale" content="${lang === "ja" ? "ja_JP" : "en_US"}">
<meta property="og:image" content="${escapeHtml(imageUrl)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${escapeHtml(title)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(description)}">
<meta name="twitter:image" content="${escapeHtml(imageUrl)}">
<meta name="theme-color" content="#0f172a">
<link rel="icon" href="https://susumutomita.github.io/TenkaCloud/assets/favicon.svg" type="image/svg+xml">
<link rel="icon" href="https://susumutomita.github.io/TenkaCloud/assets/favicon-32.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="https://susumutomita.github.io/TenkaCloud/assets/apple-touch-icon.png">
<style>
  :root {
    --c-text: #1f2328;
    --c-muted: #59636e;
    --c-border: #d1d9e0;
    --c-bg: #ffffff;
    --c-bg-soft: #f6f8fa;
    --c-info: #0969da;
    --c-warn: #9a6700;
    --c-danger: #cf222e;
    --c-ok: #1a7f37;
    --c-code-bg: #eff1f3;
  }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Yu Gothic UI", sans-serif;
    color: var(--c-text); background: var(--c-bg);
    max-width: 960px; margin: 2rem auto; padding: 0 1.5rem; line-height: 1.6;
  }
  h1 { font-size: 1.6rem; border-bottom: 2px solid var(--c-border); padding-bottom: .4rem; }
  h2 { font-size: 1.25rem; margin-top: 2.2rem; border-bottom: 1px solid var(--c-border); padding-bottom: .3rem; }
  h3 { font-size: 1.05rem; margin-top: 1.6rem; }
  h4 { font-size: 0.95rem; margin-top: 1.2rem; color: var(--c-muted); }
  code { background: var(--c-code-bg); padding: 0.1em 0.35em; border-radius: 3px; font-size: 0.9em; }
  pre { background: var(--c-bg-soft); border: 1px solid var(--c-border); border-radius: 4px;
        padding: .8rem 1rem; overflow-x: auto; font-size: 0.88rem; line-height: 1.45; }
  pre code { background: none; padding: 0; font-size: inherit; }
  a { color: var(--c-info); }
  table { border-collapse: collapse; margin: 0.6rem 0; width: 100%; font-size: 0.92rem; }
  th, td { border: 1px solid var(--c-border); padding: 6px 10px; vertical-align: top; }
  th { background: var(--c-bg-soft); text-align: left; font-weight: 600; }
  ul, ol { margin: 0.4rem 0; padding-left: 1.6rem; }
  li { margin: 0.15rem 0; }
  blockquote { border-left: 4px solid var(--c-border); margin: .6rem 0; padding: .2rem 1rem;
               color: var(--c-muted); background: var(--c-bg-soft); }
  hr { border: 0; border-top: 1px solid var(--c-border); margin: 2rem 0; }
  .doc-source {
    margin-top: 3rem; padding-top: 1rem; border-top: 1px solid var(--c-border);
    font-size: 0.82rem; color: var(--c-muted);
  }
  .doc-source code { font-size: 0.82rem; }
</style>
</head>
<body>
${bodyHtml}
<div class="doc-source">Source: <code>${escapeHtml(sourcePath)}</code> — このファイルは
<code>scripts/build-docs.ts</code> が markdown から自動生成したものです。直接編集せず
<code>${escapeHtml(sourcePath)}</code> 側を直して <code>make build-docs</code> を実行してください。</div>
</body>
</html>
`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 再帰的に dir を walk して .md ファイルを集める。 */
function walkMd(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...walkMd(full));
    } else if (name.endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

function extractTitle(md: string, fallback: string): string {
  const m = md.match(/^#\s+(.+?)\s*$/m);
  return m?.[1] ?? fallback;
}

function detectLanguage(mdPath: string, md: string): "en" | "ja" {
  if (mdPath.endsWith(".ja.md")) {
    return "ja";
  }
  const sample = md.slice(0, 4000);
  const jaChars = (sample.match(/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/gu) ?? [])
    .length;
  const latinChars = (sample.match(/[A-Za-z]/g) ?? []).length;
  return jaChars >= 40 && jaChars / Math.max(jaChars + latinChars, 1) > 0.18 ? "ja" : "en";
}

function stripMarkdownInline(s: string): string {
  return s
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[*_~>#]/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractDescription(md: string, title: string): string {
  let inFence = false;
  const paragraphs: string[] = [];
  let current: string[] = [];

  for (const line of md.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence || trimmed.startsWith("#")) {
      continue;
    }
    if (
      trimmed === "" ||
      trimmed.startsWith("|") ||
      trimmed.startsWith(">") ||
      trimmed.startsWith("- ") ||
      /^\d+\.\s/.test(trimmed)
    ) {
      if (current.length > 0) {
        paragraphs.push(current.join(" "));
        current = [];
      }
      continue;
    }
    current.push(trimmed);
  }
  if (current.length > 0) {
    paragraphs.push(current.join(" "));
  }

  const first = paragraphs.map(stripMarkdownInline).find((p) => p.length >= 40);
  const description = first ?? `${title} — TenkaCloud documentation.`;
  return description.length > 180 ? `${description.slice(0, 177).trimEnd()}...` : description;
}

function docsCanonicalUrl(htmlPath: string): string {
  const htmlRel = relative(REPO_ROOT, htmlPath).replaceAll("\\", "/");
  return `https://susumutomita.github.io/TenkaCloud/${htmlRel}`;
}

async function buildOne(mdPath: string): Promise<{ htmlPath: string; html: string }> {
  const md = readFileSync(mdPath, "utf8");
  const htmlPath = mdPath.replace(/\.md$/, ".html");
  const sourceRel = relative(REPO_ROOT, mdPath);
  const title = extractTitle(md, sourceRel);
  const description = extractDescription(md, title);
  const lang = detectLanguage(mdPath, md);
  const canonicalUrl = docsCanonicalUrl(htmlPath);
  const imageUrl = "https://susumutomita.github.io/TenkaCloud/assets/og-image.png";
  const bodyHtml = await marked.parse(md, { async: true });
  return {
    htmlPath,
    html: template({
      title,
      description,
      lang,
      canonicalUrl,
      imageUrl,
      bodyHtml,
      sourcePath: sourceRel,
    }),
  };
}

async function main(): Promise<void> {
  const checkMode = process.argv.includes("--check");
  const mds = walkMd(DOCS_ROOT);
  let outOfSync = 0;
  for (const mdPath of mds) {
    const { htmlPath, html } = await buildOne(mdPath);
    const sourceRel = relative(REPO_ROOT, mdPath);
    if (checkMode) {
      let existing = "";
      try {
        existing = readFileSync(htmlPath, "utf8");
      } catch {
        // 存在しないので out-of-sync
      }
      if (existing !== html) {
        outOfSync++;
        console.error(`[build-docs] out of sync: ${sourceRel}`);
      }
    } else {
      writeFileSync(htmlPath, html, "utf8");
      console.log(`[build-docs] wrote ${relative(REPO_ROOT, htmlPath)}`);
    }
  }
  if (checkMode && outOfSync > 0) {
    console.error(`\n${outOfSync} doc(s) are out of sync. Run \`make build-docs\` to regenerate.`);
    process.exit(1);
  }
}

await main();
