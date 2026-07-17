import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("landing page SEO", () => {
  const index = read("landing/index.html");
  const app = read("landing/app.js");

  it("should publish Japanese default metadata on the TenkaCloud domain", () => {
    expect(index).toContain('<html lang="ja">');
    expect(index).toContain(
      "<title>TenkaCloud | AWSクラウド実戦演習・競技プラットフォーム</title>",
    );
    expect(index).toContain('<link rel="canonical" href="https://tenkacloud.com/?lang=ja" />');
    expect(index).toContain('<meta property="og:url" content="https://tenkacloud.com/?lang=ja" />');
    expect(index).not.toContain("susumutomita.github.io/TenkaCloud");
  });

  it("should declare reciprocal Japanese and English alternatives", () => {
    expect(index).toContain(
      '<link rel="alternate" hreflang="ja" href="https://tenkacloud.com/?lang=ja" />',
    );
    expect(index).toContain(
      '<link rel="alternate" hreflang="en" href="https://tenkacloud.com/index.en.html" />',
    );
    expect(index).toContain(
      '<link rel="alternate" hreflang="x-default" href="https://tenkacloud.com/" />',
    );
  });

  it("should update document metadata when the visible language changes", () => {
    expect(app).toContain("function applySeoMetadata(lang)");
    expect(app).toContain("document.title = metadata.title;");
    expect(app).toContain('setMetaContent("description", metadata.description);');
    expect(app).toContain('setLinkHref("canonical", metadata.canonical);');
    expect(app).toContain("applySeoMetadata(lang);");
    expect(app).toContain("https://tenkacloud.com/index.en.html");
    expect(app).toContain("https://tenkacloud.com/?lang=ja");
  });

  it("should publish a static English landing page for non-JavaScript crawlers", () => {
    const english = read("landing/index.en.html");
    expect(english).toContain('<html lang="en" data-static-lang="en">');
    expect(english).toContain(
      "<title>TenkaCloud | Open-source AWS cloud competition platform</title>",
    );
    expect(english).toContain(
      '<link rel="canonical" href="https://tenkacloud.com/index.en.html" />',
    );
    expect(english).toContain("The cloud engineer's");
    expect(english).toContain("Build cloud capability across the org.");
  });

  it("should expose organization, website, and software structured data", () => {
    const match = index.match(
      /<script id="seo-structured-data" type="application\/ld\+json">([\s\S]*?)<\/script>/,
    );
    expect(match).not.toBeNull();
    const structuredData = JSON.parse(match?.[1] ?? "{}");
    const types = structuredData["@graph"].map((entry: { "@type": string }) => entry["@type"]);
    expect(types).toContain("Organization");
    expect(types).toContain("WebSite");
    expect(types).toContain("SoftwareApplication");
    expect(types).toContain("WebPage");
  });

  it("should publish crawler policy and a sitemap", () => {
    const robots = read("landing/robots.txt");
    expect(robots).toContain("User-agent: OAI-SearchBot");
    expect(robots).toContain("User-agent: PerplexityBot");
    expect(robots).toContain("Content-Signal: search=yes,ai-input=yes,ai-train=no");
    expect(robots).toContain("Sitemap: https://tenkacloud.com/sitemap.xml");

    const sitemap = read("landing/sitemap.xml");
    expect(sitemap).toContain("<loc>https://tenkacloud.com/?lang=ja</loc>");
    expect(sitemap).toContain("<loc>https://tenkacloud.com/index.en.html</loc>");
    expect(sitemap).toContain('hreflang="ja"');
    expect(sitemap).toContain('hreflang="en"');
  });

  it("should use the custom domain and reciprocal hreflang on legal pages", () => {
    const pagePairs = [
      ["legal.html", "legal.en.html"],
      ["privacy.html", "privacy.en.html"],
      ["terms.html", "terms.en.html"],
    ];

    for (const [jaPage, enPage] of pagePairs) {
      const ja = read(`landing/${jaPage}`);
      const en = read(`landing/${enPage}`);
      for (const page of [ja, en]) {
        expect(page).not.toContain("susumutomita.github.io/TenkaCloud");
        expect(page).toContain('<link rel="alternate" hreflang="ja"');
        expect(page).toContain('<link rel="alternate" hreflang="en"');
        expect(page).toContain('<link rel="alternate" hreflang="x-default"');
      }
    }
  });

  it("should point AI-readable project links at the canonical landing page", () => {
    const llms = read("landing/llms.txt");
    expect(llms).toContain("https://tenkacloud.com/?lang=ja");
    expect(llms).toContain("https://tenkacloud.com/index.en.html");
    expect(llms).not.toContain("susumutomita.github.io/TenkaCloud");
  });

  it("should allow mobile feature tiles to shrink within the viewport", () => {
    const styles = read("landing/styles/main.css");
    expect(styles).toMatch(/\.tile\s*\{[^}]*min-width:\s*0;/s);
    expect(styles).toMatch(
      /@media \(max-width: 640px\)[\s\S]*\.quest-card\s*\{[^}]*flex-wrap:\s*wrap;/,
    );
  });
});

/**
 * Issue #2696 PR 4: the hero CTA row used to expose three co-equal links
 * (get-quote / try-demo / try-oss). The onboarding audit's P0 checkbox 1
 * requires the top CTA to collapse to exactly two primary choices — "play
 * first" (Codespaces, no AWS) and "host your own event" (Deploy on AWS) —
 * with the commercial Hosted Event quote demoted to a secondary hero link
 * rather than removed (orchestrator decision: analytics/behavior for
 * data-cta="get-quote" must keep working, so its attribute and href are
 * pinned unchanged even though it moves out of .cta-row).
 */
describe("landing hero CTA two-choice onboarding split (Issue #2696 PR 4)", () => {
  const index = read("landing/index.html");
  const app = read("landing/app.js");

  function heroSection(html: string): string {
    const start = html.indexOf('<section class="hero">');
    const end = html.indexOf('<section class="alt" id="modes">');
    expect(start, "hero section not found").toBeGreaterThan(-1);
    expect(end, "modes section not found").toBeGreaterThan(start);
    return html.slice(start, end);
  }

  function ctaRow(html: string): string {
    const hero = heroSection(html);
    const start = hero.indexOf('<div class="cta-row">');
    const end = hero.indexOf("</div>", start);
    expect(start, "cta-row not found in hero").toBeGreaterThan(-1);
    return hero.slice(start, end);
  }

  it("should present exactly two primary CTAs in the hero cta-row", () => {
    const row = ctaRow(index);
    const primaryMatches = [...row.matchAll(/class="cta-primary"/g)];
    expect(primaryMatches).toHaveLength(2);
  });

  it("should point the play-first primary CTA at GitHub Codespaces", () => {
    const row = ctaRow(index);
    expect(row).toContain('data-cta="try-codespaces"');
    expect(row).toContain('href="https://codespaces.new/susumutomita/TenkaCloud"');
  });

  it("should point the host-your-own-event primary CTA at the README Deploy on AWS section", () => {
    const row = ctaRow(index);
    expect(row).toContain('data-cta="deploy-aws"');
    expect(row).toContain('href="https://github.com/susumutomita/TenkaCloud#deploy-on-aws"');
  });

  it("should demote the Hosted Event quote CTA out of the primary cta-row while preserving its data-cta and href", () => {
    const hero = heroSection(index);
    const row = ctaRow(index);
    expect(row).not.toContain("get-quote");
    expect(hero).toContain('data-cta="get-quote"');
    expect(hero).toContain('href="#pricing"');
  });

  it("should keep the live-demo CTA as a secondary hero link, not a primary onboarding choice", () => {
    const hero = heroSection(index);
    const row = ctaRow(index);
    expect(row).not.toContain("try-demo");
    expect(hero).toContain('data-cta="try-demo"');
    expect(hero).toContain('href="/portal-demo/?demo=1"');
  });

  it("should define matching ja/en hero copy for the two-choice onboarding split in app.js", () => {
    expect(app).toContain('"hero.cta_play": "まず遊ぶ"');
    expect(app).toContain('"hero.cta_play_note": "推奨 · AWS 不要 · 約 5 分"');
    expect(app).toContain('"hero.cta_host": "自分のイベントを開く"');
    expect(app).toContain('"hero.cta_host_note": "AWS アカウント · 課金あり · 約 30 分"');
    expect(app).toContain('"hero.cta_play": "Play first"');
    expect(app).toContain('"hero.cta_play_note": "Recommended · No AWS · ~5 min"');
    expect(app).toContain('"hero.cta_host": "Host your own event"');
    expect(app).toContain('"hero.cta_host_note": "AWS account · Billed · ~30 min"');
  });

  it("should publish the same two-choice CTA structure on the generated English landing page", () => {
    const english = read("landing/index.en.html");
    const row = ctaRow(english);
    expect([...row.matchAll(/class="cta-primary"/g)]).toHaveLength(2);
    expect(row).toContain('data-cta="try-codespaces"');
    expect(row).toContain('data-cta="deploy-aws"');
    expect(english).toContain("Play first");
    expect(english).toContain("Host your own event");
  });
});
