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
 * Issue #2711 (design 6a, supersedes the #2707 start-direct buttons): the hero
 * shows exactly one participant entry — a quest card for the tutorial problem
 * what-is-tenkacloud — with no stacked primary buttons. The organizer path is
 * demoted to a text-link row below the card. The Lite/Codespaces mode choice
 * must not appear on the LP at all (it lives inside the problem, step 3).
 * Analytics continuity: start-drill / deploy-aws / get-quote keep their
 * data-cta attributes and destinations.
 */
describe("landing hero quest card (Issue #2711)", () => {
  const index = read("landing/index.html");
  const app = read("landing/app.js");

  function heroSection(html: string): string {
    const start = html.indexOf('<section class="hero">');
    const end = html.indexOf('<section class="alt" id="modes">');
    expect(start, "hero section not found").toBeGreaterThan(-1);
    expect(end, "modes section not found").toBeGreaterThan(start);
    return html.slice(start, end);
  }

  it("should show no stacked primary buttons (cta-primary / cta-row) in the hero", () => {
    const hero = heroSection(index);
    expect(hero).not.toContain("cta-primary");
    expect(hero).not.toContain("cta-row");
  });

  it("should present exactly one quest card that deep-links to the tutorial problem", () => {
    const hero = heroSection(index);
    expect([...hero.matchAll(/class="hero-quest-card"/g)]).toHaveLength(1);
    expect(hero).toContain('href="/portal-demo/start?demo=1"');
    expect(hero).toContain('data-cta="start-drill"');
    expect(hero).toContain("<code>what-is-tenkacloud</code>");
    // 同一 origin への直行なので新規 tab で開かない (= 直行型の体験を壊さない)。
    const card = hero.slice(hero.indexOf('class="hero-quest-card"'));
    expect(card.slice(0, card.indexOf(">"))).not.toContain("target=");
  });

  it("should not present the Lite/Codespaces mode choice anywhere in the hero", () => {
    const hero = heroSection(index);
    expect(hero).not.toContain("codespaces.new");
    expect(hero).not.toContain("Codespaces");
  });

  it("should demote the organizer links to a text row with data-cta and hrefs preserved", () => {
    const hero = heroSection(index);
    expect(hero).toContain('data-cta="deploy-aws"');
    expect(hero).toContain('href="https://github.com/susumutomita/TenkaCloud#deploy-on-aws"');
    expect(hero).toContain('data-cta="get-quote"');
    expect(hero).toContain('href="#pricing"');
  });

  it("should define matching ja/en quest-card copy in app.js", () => {
    expect(app).toContain('"hero.quest_meta": "最初の 1 問 · 登録不要 · 約 3 分"');
    expect(app).toContain('"hero.quest_badge": "チュートリアル"');
    expect(app).toContain('"hero.quest_title": "TenkaCloud とは? を、触って知る。"');
    expect(app).toContain('"hero.quest_cta": "この問題で始める"');
    expect(app).toContain('"hero.host_prefix": "主催者の方へ:"');
    expect(app).toContain('"hero.quest_meta": "First quest · No signup · ~3 min"');
    expect(app).toContain('"hero.quest_badge": "Tutorial"');
    expect(app).toContain('"hero.quest_title": "Learn what TenkaCloud is — by playing it."');
    expect(app).toContain('"hero.quest_cta": "Start with this quest"');
    expect(app).toContain('"hero.host_prefix": "Hosting an event?"');
  });

  it("should publish the same quest-card structure on the generated English landing page", () => {
    const english = read("landing/index.en.html");
    const hero = heroSection(english);
    expect(hero).not.toContain("cta-primary");
    expect([...hero.matchAll(/class="hero-quest-card"/g)]).toHaveLength(1);
    expect(hero).toContain('data-cta="start-drill"');
    expect(english).toContain("Learn what TenkaCloud is");
  });
});
