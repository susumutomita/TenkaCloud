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

  it("should present exactly one quest card that lands on a real file (rewrite-independent)", () => {
    const hero = heroSection(index);
    expect([...hero.matchAll(/class="hero-quest-card"/g)]).toHaveLength(1);
    // /portal-demo/start の deep link は静的ホスティングの rewrite が無い環境で 404
    // fallback に崩れる。 入口は必ず実在する index.html + `goto=start` (SPA 側で遷移)。
    expect(hero).toContain('href="/portal-demo/?demo=1&amp;goto=start"');
    expect(hero).not.toContain('href="/portal-demo/start');
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

/**
 * #2711 follow-up: hero カード無スタイル事故の再発防止。 アセットのキャッシュバスターは
 * 手動日付 (`?v=20260625-2`) だと bump を忘れて古い CSS が配信され続けるため、 内容
 * ハッシュ (`scripts/landing/stamp-asset-versions.ts`) に固定する。 このテストは
 * 「参照 URL のハッシュ == 実ファイルの内容ハッシュ」 を機械検証し、 CSS/JS を変えて
 * スタンプし忘れた PR を CI で落とす。
 */
describe("landing asset cache busting (content-hash stamped)", () => {
  const { assetVersion, stampHtml } = require("./stamp-asset-versions") as {
    assetVersion: (content: string) => string;
    stampHtml: (html: string, css: string, js: string) => string;
  };
  const cssVersion = assetVersion(read("landing/styles/main.css"));
  const jsVersion = assetVersion(read("landing/app.js"));

  it("should reference main.css and app.js with their current content hashes", () => {
    for (const page of ["landing/index.html", "landing/index.en.html"]) {
      const html = read(page);
      expect(html).toContain(`./styles/main.css?v=${cssVersion}`);
      expect(html).toContain(`./app.js?v=${jsVersion}`);
      expect(html).not.toMatch(/\.\/styles\/main\.css\?v=(?!${"x"})[0-9]{8}-/);
    }
  });

  it("should stamp idempotently", () => {
    const html = read("landing/index.html");
    expect(stampHtml(html, cssVersion, jsVersion)).toBe(html);
  });
});

/**
 * デモ deep link のリロード復旧: Cloudflare Pages は 404.html 不在時の暗黙 SPA fallback で
 * 未知パスに root index.html (= landing) を返し、 これは landing/_redirects の
 * `/portal-demo/* 200` rewrite より優先される。 landing 側の head 先頭スクリプトが
 * demo prefix を検知して `/portal-demo/?goto=<元パス>` へ replace し、 SPA 側
 * (RootEntryPage) がルートを復元する。 このスクリプトが両言語の landing に載っていること、
 * 相対アセットの取得より前 (= stylesheet link より前) に置かれていることを pin する。
 */
describe("demo deep-link reload recovery (Cloudflare implicit SPA fallback)", () => {
  it("should ship the recovery script on both landing pages, before the stylesheet", () => {
    for (const page of ["landing/index.html", "landing/index.en.html"]) {
      const html = read(page);
      const scriptAt = html.indexOf("portal-demo|admin-demo");
      const stylesheetAt = html.indexOf('rel="stylesheet"');
      expect(scriptAt, `${page} lacks the recovery script`).toBeGreaterThan(-1);
      expect(scriptAt, `${page} loads assets before the recovery script`).toBeLessThan(
        stylesheetAt,
      );
      expect(html).toContain("location.replace");
      expect(html).toContain('"/?goto=" + encodeURIComponent');
    }
  });
});

/**
 * AI エージェント向け導線: llms-full.txt (自己完結ブリーフィング) と、 #extend 内の
 * 貼り付けプロンプト。 プロンプトは LLM 向けなので言語切替しない (data-i18n なし)。
 */
describe("AI-agent briefing and paste-able prompt", () => {
  const full = read("landing/llms-full.txt");
  const llms = read("landing/llms.txt");
  const index = read("landing/index.html");
  const english = read("landing/index.en.html");

  it("should ship a self-contained llms-full.txt with both quick starts", () => {
    expect(full).toContain("Instructions for the agent reading this");
    expect(full).toContain("https://tenkacloud.com/portal-demo/?demo=1&goto=start");
    expect(full).toContain("https://codespaces.new/susumutomita/TenkaCloud");
    expect(full).toContain("ACTION=destroy");
    expect(full).toContain("Apache 2.0");
    // ドリルのチェックポイントコード実値はネタバレになるので載せない。
    expect(full).not.toMatch(/TENKA\{[A-Z0-9-]+\}/);
  });

  it("should link llms-full.txt from llms.txt", () => {
    expect(llms).toContain("https://tenkacloud.com/llms-full.txt");
  });

  it("should render the copyable agent prompt on both landing pages", () => {
    for (const html of [index, english]) {
      expect(html).toContain('id="agent-prompt-text"');
      expect(html).toContain('data-copy-target="agent-prompt-text"');
      expect(html).toContain("Fetch https://tenkacloud.com/llms-full.txt");
    }
    // プロンプト本文は言語切替対象にしない。
    const pre = index.slice(index.indexOf('id="agent-prompt-text"'));
    expect(pre.slice(0, pre.indexOf(">"))).not.toContain("data-i18n");
  });

  it("should wire the copy button handler in app.js", () => {
    const app = read("landing/app.js");
    expect(app).toContain("[data-copy-target]");
    expect(app).toContain("navigator.clipboard.writeText");
  });
});

/**
 * #2696 P1: 30 秒 LP 動画。 hero の secondary 行と両 README の CTA 付近から
 * 参照され、 自ホスト mp4 (16:9 / 9:16) + README 用 preview GIF が実在する。
 */
describe("30-second product video placement (#2696 P1)", () => {
  it("should ship the self-hosted 30s assets", () => {
    const { existsSync } = require("node:fs") as typeof import("node:fs");
    for (const path of [
      "landing/videos/lp/tenkacloud-30s.mp4",
      "landing/videos/lp/tenkacloud-30s-vertical.mp4",
      "docs/assets/lp-30s/tenkacloud-30s-preview.gif",
      "docs/assets/lp-30s/tenkacloud-30s-poster.jpg",
    ]) {
      expect(existsSync(join(root, path)), `${path} missing`).toBe(true);
    }
  });

  it("should link the 30s video from the hero secondary row on both pages", () => {
    for (const page of ["landing/index.html", "landing/index.en.html"]) {
      const html = read(page);
      expect(html).toContain('data-cta="watch-30s"');
      expect(html).toContain('href="/videos/lp/tenkacloud-30s.mp4"');
    }
  });

  it("should embed the preview GIF near the top CTA of both READMEs", () => {
    for (const page of ["README.md", "README.ja.md"]) {
      const md = read(page);
      expect(md).toContain("docs/assets/lp-30s/tenkacloud-30s-preview.gif");
      expect(md).toContain("landing/videos/lp/tenkacloud-30s.mp4");
      expect(md).toContain("landing/videos/lp/tenkacloud-30s-vertical.mp4");
    }
  });
});
