import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { currentVersions, STAMPED_ASSETS, stampHtml } from "./stamp-asset-versions";

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

describe("documentation home by role", () => {
  const japanese = read("landing/docs/index.html");
  const english = read("landing/docs/index.en.html");

  it("should use a role-neutral title and lead with all four manuals", () => {
    expect(japanese).toContain("<h1>TenkaCloud ドキュメント</h1>");
    expect(japanese).not.toContain("<h1>開発者ドキュメント</h1>");
    expect(japanese).toContain("開発者マニュアル");
    expect(japanese).toContain("競技開催者マニュアル");
    expect(japanese).toContain("競技参加者マニュアル");
    expect(japanese).toContain("問題作成者マニュアル");
    expect(japanese.indexOf("<h2>役割別マニュアル</h2>")).toBeLessThan(
      japanese.indexOf("<h2>はじめに</h2>"),
    );

    expect(english).toContain("<h1>TenkaCloud documentation</h1>");
    expect(english).not.toContain("<h1>Developer docs</h1>");
  });

  it("should publish the problem-author flow diagram and Lite references", () => {
    const author = read("landing/docs/manual/problem-author/index.html");
    expect(author).toContain("/docs/assets/problem-author-flow.ja.svg");
    expect(read("landing/docs/assets/problem-author-flow.ja.svg")).toContain("<title");
    expect(read("landing/docs/reference/lite-settings/index.html")).toContain("16〜128文字");
    expect(read("landing/docs/reference/lite-messages/index.html")).toContain("システムの処置");
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
  const versions = currentVersions();

  it("should reference every stamped asset with its current content hash", () => {
    for (const page of ["landing/index.html", "landing/index.en.html"]) {
      const html = read(page);
      for (const asset of STAMPED_ASSETS) {
        expect(html).toContain(`./${asset}?v=${versions[asset]}`);
      }
      // 手動日付バスター (`?v=20260625-2`) の残骸を落とす。 内容ハッシュは
      // 16 進 10 桁でハイフンを含まないため、 この形にはならない。
      expect(html).not.toMatch(/\.\/styles\/main\.css\?v=\d{8}-/);
    }
  });

  it("should stamp idempotently", () => {
    const html = read("landing/index.html");
    expect(stampHtml(html, versions)).toBe(html);
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

  // 404.html の存在自体が Cloudflare の暗黙 SPA fallback (= 未知パスに root index.html を
  // 200 で返す) を解除するスイッチ。 消えると「崩れた landing」 が復活するので存在を pin する。
  it("should ship a custom 404 page that disables the implicit SPA fallback", () => {
    const html = read("landing/404.html");
    // デモ deep link が _redirects に拾われずここへ落ちても復旧できる (index.html と同じ script)。
    expect(html).toContain("portal-demo|admin-demo");
    expect(html).toContain('"/?goto=" + encodeURIComponent');
    // 任意の深さの URL で描画されるため、 相対パスの外部アセット参照は禁止 (inline 自己完結)。
    expect(html).not.toMatch(/(?:href|src)="\.\.?\//);
    expect(html).not.toContain('rel="stylesheet"');
    // 迷子ユーザー向けの両言語コピーと帰り道。
    expect(html).toContain("ページが見つかりません");
    expect(html).toContain("Page not found");
    expect(html).toContain('href="/"');
    expect(html).toContain('name="robots" content="noindex"');
  });
});

describe("portal demo runtime config (Issue #2828)", () => {
  it("should generate the mock runtime config in the deployed portal-demo directory", () => {
    const packageJson = JSON.parse(read("package.json")) as {
      scripts?: Record<string, string>;
    };
    const buildPages = packageJson.scripts?.["build:pages"] ?? "";

    expect(buildPages).toContain(
      "scripts/ops/participant-portal-runtime-config.ts --cloud-mode mock",
    );
    expect(buildPages).toContain("--out landing/portal-demo/runtime-config.json");
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

  it("should embed the language-specific YouTube Mac demo beside the prompt", () => {
    const app = read("landing/app.js");

    for (const html of [index, english]) {
      expect(html).toContain('class="agent-prompt-video"');
      expect(html).toContain('data-i18n-src="extend.agent_video_embed_src"');
      expect(html).toContain('data-i18n-title="extend.agent_video_title"');
      expect(html).toContain('data-cta="watch-ai-local-mac"');
      expect(html).toContain('data-i18n-href="extend.agent_video_href"');
      expect(html).toContain('data-cta="try-ai-local-mac"');
      expect(html).toContain("goto=/problems/01HZX0M2A1AGENTMACTENKA0003");
    }
    expect(index).toContain('src="https://www.youtube.com/embed/nLsSJ3npdfw"');
    expect(index).toContain('href="https://www.youtube.com/watch?v=nLsSJ3npdfw"');
    expect(english).toContain('src="https://www.youtube.com/embed/GDu9FhWrQns"');
    expect(english).toContain('href="https://www.youtube.com/watch?v=GDu9FhWrQns"');
    expect(app).toContain('querySelectorAll("[data-i18n-href]")');
    expect(app).toContain('querySelectorAll("[data-i18n-src]")');
    expect(app).toContain('querySelectorAll("[data-i18n-title]")');
  });
});

/**
 * #2696 P1: 30 秒 LP 動画。 hero の secondary 行と両 README の CTA 付近から
 * 参照され、 自ホスト mp4 (16:9 / 9:16) + README 用 preview GIF が実在する。
 */
describe("30-second product video placement (#2696 P1)", () => {
  it("should ship the self-hosted 30s assets", () => {
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
