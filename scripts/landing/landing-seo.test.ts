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
 * Issue #2707 P0-5 (supersedes the #2696 PR 4 two-choice split): the hero now
 * leads straight into the product — the primary CTA 「始める」 deep-links to the
 * demo portal's `/start` route, which lands on onboarding drill problem 1.
 * The two-primary discipline from #2696 is kept (start-drill / deploy-aws);
 * Codespaces moves to a secondary hero link because onboarding drill problem 2
 * sends visitors there with full context. Analytics continuity: get-quote and
 * try-codespaces keep their data-cta attributes and hrefs; try-demo is retired
 * because its destination (the demo portal) became the primary CTA itself.
 */
describe("landing hero start-direct CTA (Issue #2707 P0-5)", () => {
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

  it("should point the start primary CTA straight at the demo portal /start deep link", () => {
    const row = ctaRow(index);
    expect(row).toContain('data-cta="start-drill"');
    expect(row).toContain('href="/portal-demo/start?demo=1"');
    // 同一 origin への直行なので新規 tab で開かない (= 直行型の体験を壊さない)。
    const startAnchor = row.slice(row.indexOf('href="/portal-demo/start?demo=1"'));
    expect(startAnchor.slice(0, startAnchor.indexOf(">"))).not.toContain("target=");
  });

  it("should point the host-your-own-event primary CTA at the README Deploy on AWS section", () => {
    const row = ctaRow(index);
    expect(row).toContain('data-cta="deploy-aws"');
    expect(row).toContain('href="https://github.com/susumutomita/TenkaCloud#deploy-on-aws"');
  });

  it("should demote the Codespaces CTA to a secondary hero link with its data-cta and href preserved", () => {
    const hero = heroSection(index);
    const row = ctaRow(index);
    expect(row).not.toContain("try-codespaces");
    expect(hero).toContain('data-cta="try-codespaces"');
    expect(hero).toContain('href="https://codespaces.new/susumutomita/TenkaCloud"');
  });

  it("should keep the Hosted Event quote CTA as a secondary hero link with its data-cta and href preserved", () => {
    const hero = heroSection(index);
    const row = ctaRow(index);
    expect(row).not.toContain("get-quote");
    expect(hero).toContain('data-cta="get-quote"');
    expect(hero).toContain('href="#pricing"');
  });

  it("should retire the try-demo CTA now that the demo portal is the primary destination", () => {
    const hero = heroSection(index);
    expect(hero).not.toContain("try-demo");
    expect(app).not.toContain("hero.cta_demo");
  });

  it("should define matching ja/en hero copy for the start-direct CTA in app.js", () => {
    expect(app).toContain('"hero.cta_start": "始める"');
    expect(app).toContain('"hero.cta_start_note": "登録不要 · ブラウザだけ · 約 3 分"');
    expect(app).toContain('"hero.cta_play": "Codespaces で遊ぶ"');
    expect(app).toContain('"hero.cta_host": "自分のイベントを開く"');
    expect(app).toContain('"hero.cta_start": "Start"');
    expect(app).toContain('"hero.cta_start_note": "No signup · Browser only · ~3 min"');
    expect(app).toContain('"hero.cta_play": "Play in Codespaces"');
    expect(app).toContain('"hero.cta_host": "Host your own event"');
  });

  it("should publish the same start-direct CTA structure on the generated English landing page", () => {
    const english = read("landing/index.en.html");
    const row = ctaRow(english);
    expect([...row.matchAll(/class="cta-primary"/g)]).toHaveLength(2);
    expect(row).toContain('data-cta="start-drill"');
    expect(row).toContain('data-cta="deploy-aws"');
    expect(english).toContain("Start");
    expect(english).toContain("Host your own event");
  });
});
