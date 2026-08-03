import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

interface SeoMetadata {
  title: string;
  description: string;
  socialDescription: string;
  canonical: string;
  locale: string;
  alternateLocale: string;
  imageAlt: string;
  softwareDescription: string;
}

type TranslationValue = string | [string, string][] | { n: string; u: string; l: string }[];

const root = join(import.meta.dir, "../..");
const indexPath = join(root, "landing/index.html");
const englishPath = join(root, "landing/index.en.html");
const appPath = join(root, "landing/app.js");

function propertyName(node: ts.PropertyName): string {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) {
    return node.text;
  }
  throw new Error(`Unsupported property name in landing/app.js: ${node.getText()}`);
}

function literalValue(node: ts.Expression): unknown {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.map((element) => literalValue(element as ts.Expression));
  }
  if (ts.isObjectLiteralExpression(node)) {
    const result: Record<string, unknown> = {};
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) {
        throw new Error(`Unsupported object member in landing/app.js: ${property.getText()}`);
      }
      result[propertyName(property.name)] = literalValue(property.initializer);
    }
    return result;
  }
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken) {
    return -Number(literalValue(node.operand));
  }
  throw new Error(`Unsupported literal in landing/app.js: ${node.getText()}`);
}

function extractObject<T>(source: string, variable: string): T {
  const sourceFile = ts.createSourceFile(
    appPath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  let initializer: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === variable
    ) {
      initializer = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!initializer) throw new Error(`Could not find ${variable} in landing/app.js`);
  return literalValue(initializer) as T;
}

function replaceElementContent(html: string, key: string, value: string): string {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `(<([\\w:-]+)\\b[^>]*\\bdata-i18n="${escapedKey}"[^>]*>)([\\s\\S]*?)(<\\/\\2>)`,
    "g",
  );
  return html.replace(pattern, (_match, opening, _tag, _content, closing) => {
    return `${opening}${value}${closing}`;
  });
}

function replaceI18nAttribute(
  html: string,
  key: string,
  value: string,
  attribute: "href" | "src" | "title",
): string {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `(<[\\w:-]+\\b(?=[^>]*\\bdata-i18n-${attribute}="${escapedKey}")[^>]*?\\s${attribute}=")[^"]*(")`,
    "g",
  );
  return html.replace(pattern, (_match, opening, closing) => `${opening}${value}${closing}`);
}

function replaceTagContent(html: string, tag: string, value: string): string {
  const pattern = new RegExp(`(<${tag}>)[\\s\\S]*?(<\\/${tag}>)`);
  return html.replace(pattern, (_match, opening, closing) => `${opening}${value}${closing}`);
}

function replaceAttributeContent(
  html: string,
  prefix: string,
  value: string,
  suffix = '" />',
): string {
  const pattern = new RegExp(
    `(${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})[^"]*("${suffix.slice(1)})`,
  );
  return html.replace(pattern, (_match, opening, closing) => `${opening}${value}${closing}`);
}

function buildStructuredData(metadata: SeoMetadata) {
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": "https://tenkacloud.com/#organization",
        name: "BULL LLC",
        alternateName: "合同会社BULL",
        url: "https://tenkacloud.com/",
        logo: {
          "@type": "ImageObject",
          url: "https://tenkacloud.com/assets/apple-touch-icon.png",
        },
        sameAs: ["https://github.com/susumutomita/TenkaCloud"],
      },
      {
        "@type": "WebSite",
        "@id": "https://tenkacloud.com/#website",
        name: "TenkaCloud",
        url: "https://tenkacloud.com/",
        inLanguage: ["ja", "en"],
        publisher: {
          "@id": "https://tenkacloud.com/#organization",
        },
      },
      {
        "@type": "SoftwareApplication",
        "@id": "https://tenkacloud.com/#software",
        name: "TenkaCloud",
        url: metadata.canonical,
        description: metadata.softwareDescription,
        applicationCategory: "EducationalApplication",
        applicationSubCategory: "Cloud training and competition platform",
        operatingSystem: "Web",
        isAccessibleForFree: true,
        license: "https://www.apache.org/licenses/LICENSE-2.0",
        codeRepository: "https://github.com/susumutomita/TenkaCloud",
        inLanguage: "en",
        publisher: {
          "@id": "https://tenkacloud.com/#organization",
        },
      },
      {
        "@type": "WebPage",
        "@id": `${metadata.canonical}#webpage`,
        url: metadata.canonical,
        name: metadata.title,
        description: metadata.description,
        inLanguage: "en",
        isPartOf: {
          "@id": "https://tenkacloud.com/#website",
        },
        about: {
          "@id": "https://tenkacloud.com/#software",
        },
      },
    ],
  };
}

export function generateEnglishLanding(): string {
  const app = readFileSync(appPath, "utf8");
  const seo = extractObject<Record<"ja" | "en", SeoMetadata>>(app, "SEO_METADATA");
  const i18n = extractObject<Record<"ja" | "en", Record<string, TranslationValue>>>(app, "I18N");
  const metadata = seo.en;
  const translations = i18n.en;

  let html = readFileSync(indexPath, "utf8");
  html = html.replace(
    "<!doctype html>",
    "<!doctype html>\n<!-- Generated by scripts/landing/generate-landing-locales.ts. -->",
  );
  html = html.replace('<html lang="ja">', '<html lang="en" data-static-lang="en">');

  for (const [key, value] of Object.entries(translations)) {
    if (typeof value === "string") {
      html = replaceElementContent(html, key, value);
      html = replaceI18nAttribute(html, key, value, "href");
      html = replaceI18nAttribute(html, key, value, "src");
      html = replaceI18nAttribute(html, key, value, "title");
    }
  }

  const bullets = translations["trust.bullets"] as [string, string][];
  html = html.replace(
    '<ul id="trust-bullets"></ul>',
    `<ul id="trust-bullets">${bullets
      .map(([title, body]) => `<li><span><b>${title}</b> ${body}</span></li>`)
      .join("")}</ul>`,
  );
  const stats = translations.stats as { n: string; u: string; l: string }[];
  html = html.replace(
    '<div class="stats" id="stats-grid"></div>',
    `<div class="stats" id="stats-grid">${stats
      .map(
        ({ n, u, l }) =>
          `<div class="stat"><div class="n">${n}<span class="u">${u}</span></div><div class="l">${l}</div></div>`,
      )
      .join("")}</div>`,
  );

  html = replaceTagContent(html, "title", metadata.title);
  html = replaceAttributeContent(html, '<meta name="description" content="', metadata.description);
  html = replaceAttributeContent(html, '<link rel="canonical" href="', metadata.canonical);
  html = replaceAttributeContent(html, '<meta property="og:title" content="', metadata.title);
  html = replaceAttributeContent(
    html,
    '<meta property="og:description" content="',
    metadata.socialDescription,
  );
  html = replaceAttributeContent(html, '<meta property="og:url" content="', metadata.canonical);
  html = replaceAttributeContent(html, '<meta property="og:locale" content="', metadata.locale);
  html = replaceAttributeContent(
    html,
    '<meta property="og:locale:alternate" content="',
    metadata.alternateLocale,
  );
  html = replaceAttributeContent(
    html,
    '<meta property="og:image:alt" content="',
    metadata.imageAlt,
  );
  html = replaceAttributeContent(html, '<meta name="twitter:title" content="', metadata.title);
  html = replaceAttributeContent(
    html,
    '<meta name="twitter:description" content="',
    metadata.socialDescription,
  );
  html = replaceAttributeContent(
    html,
    '<meta name="twitter:image:alt" content="',
    metadata.imageAlt,
  );

  const structuredData = JSON.stringify(buildStructuredData(metadata), null, 2);
  html = html.replace(
    /<script id="seo-structured-data" type="application\/ld\+json">[\s\S]*?<\/script>/,
    `<script id="seo-structured-data" type="application/ld+json">\n${structuredData}\n</script>`,
  );

  html = html.replace(
    '<a class="lang on" data-lang="ja" href="./?lang=ja" hreflang="ja" aria-current="page">',
    '<a class="lang" data-lang="ja" href="./?lang=ja" hreflang="ja">',
  );
  html = html.replace(
    '<a class="lang" data-lang="en" href="./index.en.html" hreflang="en">',
    '<a class="lang on" data-lang="en" href="./index.en.html" hreflang="en" aria-current="page">',
  );

  html = html
    .replaceAll("./privacy.html", "./privacy.en.html")
    .replaceAll("./terms.html", "./terms.en.html")
    .replaceAll("./legal.html", "./legal.en.html")
    .replaceAll('href="./docs/"', 'href="./docs/index.en.html"');

  return html;
}

if (import.meta.main) {
  const generated = generateEnglishLanding();
  if (process.argv.includes("--check")) {
    const current = readFileSync(englishPath, "utf8");
    if (current !== generated) {
      console.error(
        "landing/index.en.html is stale; run bun run scripts/landing/generate-landing-locales.ts",
      );
      process.exit(1);
    }
  } else {
    writeFileSync(englishPath, generated);
  }
}
