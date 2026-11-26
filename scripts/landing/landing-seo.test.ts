import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import {
  currentMediaVersions,
  currentVersions,
  MEDIA_PAGES,
  STAMPED_ASSETS,
  STAMPED_MEDIA,
  stampHtml,
  stampMedia,
} from "./stamp-asset-versions";

const root = join(import.meta.dir, "../..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("public JAWS presentation", () => {
  it("should not distribute rehearsal notes or presenter controls in the HTML source", () => {
    const html = read("landing/jaws-yokohama-2026/index.html");
    expect(html).not.toMatch(
      /speaker-notes|presenter-tools|発表原稿|読み上げない|目安 \d+秒|Nで原稿/,
    );
  });
});

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
    expect(english).toContain("How do they happen?");
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

  it("should publish the author diagram and current setup guidance", () => {
    const author = read("landing/docs/manual/problem-author/index.html");
    expect(author).toContain("/docs/assets/problem-author-flow.ja.svg");
    expect(read("landing/docs/assets/problem-author-flow.ja.svg")).toContain("<title");
    for (const suffix of ["index.html", "index.en.html"]) {
      const gettingStarted = read(`landing/docs/getting-started/${suffix}`);
      expect(gettingStarted).toContain("make local-reset");
      expect(gettingStarted).toContain("make destroy");
      expect(gettingStarted).not.toContain("825415fcda5075ad723daf9e4514eac47d7b8bb9");
      expect(read(`landing/docs/${suffix}`)).not.toContain("reference/lite-settings");
      expect(read(`landing/docs/${suffix}`)).not.toContain("reference/lite-messages");
    }
  });
  it("keeps current local/cloud guidance consistent without relabeling the historical setup", () => {
    for (const suffix of ["index.html", "index.en.html"]) {
      for (const page of ["getting-started", "concepts/architecture", "reference/runtime-matrix"]) {
        const document = read(`landing/docs/${page}/${suffix}`);
        expect(document).toContain("Lambda");
        expect(document).toContain("DynamoDB");
        expect(document).not.toContain("Cloud Turso");
        expect(document).not.toContain("クラウド用 Turso");
      }
    }
    expect(read("README.md")).not.toContain("CDK/Lambda\nplatform deployment are retired");
    expect(read("README.ja.md")).not.toContain("CDK/Lambda による基盤配置は廃止");
  });
});

/** The browser onboarding is primary; current startup stays accessible after the walkthrough. */
describe("platform-first landing entry", () => {
  const index = read("landing/index.html");
  const app = read("landing/app.js");
  function heroSection(html: string): string {
    const hero = html.match(/<section class="hero"[^>]*>[\s\S]*?<\/section>/)?.[0];
    if (!hero) throw new Error("hero section not found");
    return hero;
  }
  it("defines the platform and routes its primary action to the prominent introductory film", () => {
    const hero = heroSection(index);
    expect(hero).toContain(
      '<span class="motion-line">クラウドと</span><span class="motion-line">セキュリティを</span>',
    );
    expect(hero).toContain("実践で学ぶ。");
    expect(hero).toContain("自分たちの問題で、環境を動かして学ぶ OSS 基盤");
    expect(hero).toContain("演習の開催から回答・採点まで");
    expect(hero).toContain('href="#film"');
    expect(hero).toContain('data-cta="watch-60s"');
    expect(hero).toContain("実際の画面で紹介");
    expect(hero).toContain('href="#try"');
    expect(hero).not.toContain("3分で体験する");
    expect(hero).not.toContain("ニュースで聞く情報漏えい");
    expect(hero).not.toContain("Codespaces");
  });
  it("keeps the incident question below the platform and labels the interaction as explanatory", () => {
    const question = index.slice(
      index.indexOf('id="practice-question"'),
      index.indexOf('id="why"'),
    );
    expect(question).toContain("ニュースで聞く情報漏えい、");
    expect(question).toContain("どうやって起こるの？");
    const example = index.slice(index.indexOf('id="examples"'), index.indexOf('id="hosting"'));
    expect(example).toContain('<details class="platform-case">');
    expect(example).not.toContain('<details class="platform-case" open');
    expect(example).toContain("仕組みを説明するためのデモ");
    expect(example).toContain("架空のデータ");
    expect(example).toContain("採点は行いません");
    expect(example).not.toContain("3分");
    expect(example).not.toContain("開発中");
  });
  it("shows available paths before the example and preserves role-specific guides", () => {
    const start = index.indexOf('id="try"');
    expect(start).toBeLessThan(index.indexOf('id="examples"'));
    const paths = index.slice(start, index.indexOf('id="examples"'));
    expect(paths).toContain("実環境への攻撃・修復を行うものではありません。");
    expect(paths).toContain('data-i18n-href="mailGame.href"');
    expect(paths).toContain('href="/docs/getting-started/#local-start"');
    expect(index).toContain('data-cta="deploy-aws"');
    expect(index).toContain('href="./docs/manual/organizer/"');
    expect(index).toContain('href="./pricing.html"');
    expect(index).toContain('id="pricing"');
  });
  it("keeps language switches on the matching startup guide", () => {
    expect(app).toContain('"hero.startHref": "/docs/getting-started/#local-start"');
    expect(app).toContain('"hero.startHref": "/docs/getting-started/index.en.html#local-start"');
  });
  it("publishes the product definition, available actions and honest example in static English", () => {
    const english = read("landing/index.en.html");
    const hero = heroSection(english);
    expect(hero).toContain("open-source platform");
    expect(hero).toContain("Watch the one-minute introduction");
    expect(hero).not.toContain("Three minutes");
    expect(english).toContain("Build your service architecture and internal rules");
    expect(english).toContain("explanatory demo using fictional data");
    expect(english).toContain("no scoring");
    expect(english).toContain('href="/docs/getting-started/index.en.html#local-start"');
    expect(english).toContain('href="./docs/manual/organizer/index.en.html"');
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

  // 動画は差し替えても URL が同じなので、 Cloudflare の地域キャッシュが旧版を返し続ける。
  // 参照ごとに内容ハッシュを刻み、 差し替えてスタンプし忘れた PR を落とす。
  it("should reference every stamped video with its current content hash", () => {
    const media = currentMediaVersions();
    for (const page of MEDIA_PAGES) {
      const html = read(`landing/${page}`);
      for (const asset of STAMPED_MEDIA) {
        const references = [
          ...html.matchAll(
            new RegExp(`["'](?:\\.\\./)*/?${asset.replaceAll(".", "\\.")}[^"']*["']`, "g"),
          ),
        ].map((m) => m[0]);
        // The event page uses the full film; the LP additionally uses its own short clips.
        if (page.startsWith("ss-bootcamp") && asset.startsWith("assets/lp-motion/")) {
          expect(references).toHaveLength(0);
          continue;
        }
        expect(references.length, `${page} should reference ${asset}`).toBeGreaterThan(0);
        for (const reference of references)
          expect(reference).toContain(`${asset}?v=${media[asset]}`);
      }
      expect(stampMedia(html, media)).toBe(html);
    }
  });

  it("should add or replace the video stamp without touching other paths", () => {
    const versions = { "videos/lp/clip.mp4": "0123456789" };
    expect(stampMedia('<a href="/videos/lp/clip.mp4">', versions)).toBe(
      '<a href="/videos/lp/clip.mp4?v=0123456789">',
    );
    expect(stampMedia('<source src="../videos/lp/clip.mp4?v=aaaaaaaaaa" />', versions)).toBe(
      '<source src="../videos/lp/clip.mp4?v=0123456789" />',
    );
    expect(stampMedia('<a href="/videos/lp/clip.mp4.bak">', versions)).toBe(
      '<a href="/videos/lp/clip.mp4.bak">',
    );
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
 * 発表資料は LP 本文で扱う話題ではない。 トークのカード一覧は /presentations/ を正本にし、
 * LP には nav と footer のリンクだけを残す。 LP 本文へカードを戻すと、 製品の導線
 * (hero → modes → pricing → contact) の間に別の話題が挟まるので、 その再発を機械検出する。
 */
describe("presentations stay off the landing page body", () => {
  for (const page of ["landing/index.html", "landing/index.en.html"]) {
    it(`should keep the talk library out of ${page}`, () => {
      const html = read(page);
      expect(html).not.toContain('id="presentations"');
      expect(html).not.toContain("talk-card");
      // カード専用の stylesheet も LP からは外す (読み込むのは一覧ページだけ)。
      expect(html).not.toContain("presentations/library.css");
      // 一覧ページ自体は残し、 nav と footer から到達できる。
      expect(html).toContain('<a href="./presentations/" data-i18n="nav.presentations">');
      expect(html).toContain('<a href="./presentations/" data-i18n="footer.presentations">');
    });
  }

  it("should still publish the standalone presentations page with its talks", () => {
    const talks = read("landing/presentations/index.html");
    // 枚数は登壇が増えるたびに変わるので pin しない (= このテストの主題ではない)。
    // 「LP から外した結果、一覧ページ側まで空になっていない」ことだけを担保する。
    expect([...talks.matchAll(/class="talk-card"/g)].length).toBeGreaterThan(0);
    expect(talks).toContain('<link rel="stylesheet" href="./library.css" />');
  });
});

/**
 * フィードバックパートナー募集の提案資料は日英の対で公開する。 片方だけ枚数や価格が
 * 変わる、 料金が本編に戻る (付録の最終スライドだけに置く)、 送付前の未記入欄
 * ([担当者名] など) が公開ページに残る、 一覧から辿れなくなる、 を検出する。
 */
describe("enterprise proposal deck (ja / en)", () => {
  const pages = {
    ja: read("landing/proposal/index.html"),
    en: read("landing/proposal/index.en.html"),
  };

  it("should publish the same slides, prices and contact route in both languages", () => {
    for (const [lang, html] of Object.entries(pages)) {
      const doc = new JSDOM(html).window.document;
      expect(doc.documentElement.lang).toBe(lang);
      const slides = doc.querySelectorAll("section.slide");
      expect(slides).toHaveLength(11);
      // Pricing lives only in the appendix, the last slide.
      const appendix = slides[slides.length - 1];
      expect(appendix.classList.contains("pp-appendix")).toBe(true);
      expect(doc.querySelectorAll(".pp-amt")).toHaveLength(
        appendix.querySelectorAll(".pp-amt").length,
      );
      expect(doc.querySelector('link[rel="alternate"][hreflang="ja"]')?.getAttribute("href")).toBe(
        "https://tenkacloud.com/proposal/",
      );
      expect(doc.querySelector('link[rel="alternate"][hreflang="en"]')?.getAttribute("href")).toBe(
        "https://tenkacloud.com/proposal/index.en.html",
      );
      const prices = [...doc.querySelectorAll(".pp-amt")].map((e) => e.textContent);
      expect(prices).toEqual(
        lang === "ja" ? ["50万円", "150万円", "600万円〜"] : ["¥500K", "¥1.5M", "¥6M+"],
      );
      expect(doc.querySelector('a[href="https://forms.gle/djVprYmq3hFgJA7P9"]')).not.toBeNull();
      // Draft decks mark unfilled fields as [担当者名] / [Email]; the published copy has none.
      expect(doc.body.textContent).not.toContain("[");
    }
  });

  it("should be reachable from the presentations library and the sitemap", () => {
    expect(read("landing/presentations/index.html")).toContain('href="../proposal/"');
    const sitemap = read("landing/sitemap.xml");
    expect(sitemap).toContain("<loc>https://tenkacloud.com/proposal/</loc>");
    expect(sitemap).toContain("<loc>https://tenkacloud.com/proposal/index.en.html</loc>");
  });
});

/**
 * LP 動画。 hero の secondary 行と両 README の CTA 付近から 1 分の紹介動画を参照する。
 * 以前の 30 秒版 (#2696 P1、 16:9 / 9:16) は README から引き続き辿れる。
 */
describe("product video placement (#2696 P1)", () => {
  it("should ship the self-hosted 60s and 30s assets", () => {
    for (const path of [
      "landing/videos/lp/tenkacloud-60s.mp4",
      "docs/assets/lp-60s/tenkacloud-60s-preview.gif",
      "docs/assets/lp-60s/tenkacloud-60s-poster.jpg",
      "docs/assets/lp-60s/README.md",
      "landing/videos/lp/tenkacloud-30s.mp4",
      "landing/videos/lp/tenkacloud-30s-vertical.mp4",
      "docs/assets/lp-30s/tenkacloud-30s-preview.gif",
      "docs/assets/lp-30s/tenkacloud-30s-poster.jpg",
    ]) {
      expect(existsSync(join(root, path)), `${path} missing`).toBe(true);
    }
  });

  it("should keep the LP video within the Cloudflare Pages per-file limit", () => {
    const bytes = statSync(join(root, "landing/videos/lp/tenkacloud-60s.mp4")).size;
    expect(bytes).toBeLessThan(25 * 1024 * 1024);
  });

  it("should link the official YouTube video from the hero and retain the self-hosted full film", () => {
    for (const page of ["landing/index.html", "landing/index.en.html"]) {
      const html = read(page);
      expect(html).toContain('data-cta="watch-60s"');
      const version = currentMediaVersions()["videos/lp/tenkacloud-60s.mp4"];
      expect(html).toContain('href="https://youtu.be/k3087kMJmgI"');
      expect(html).toContain(`src="/videos/lp/tenkacloud-60s.mp4?v=${version}"`);
      expect(html).not.toContain("tenkacloud-30s.mp4");
    }
  });

  it("should embed the 60s preview GIF near the top CTA of both READMEs", () => {
    for (const page of ["README.md", "README.ja.md"]) {
      const md = read(page);
      expect(md).toContain("docs/assets/lp-60s/tenkacloud-60s-preview.gif");
      expect(md).toContain("landing/videos/lp/tenkacloud-60s.mp4");
      expect(md).toContain("docs/assets/lp-60s/README.md");
      expect(md).toContain("landing/videos/lp/tenkacloud-30s.mp4");
      expect(md).toContain("landing/videos/lp/tenkacloud-30s-vertical.mp4");
    }
  });
});

describe("catalog documentation entry points", () => {
  for (const [landing, suffix] of [
    ["landing/index.html", ""],
    ["landing/index.en.html", "index.en.html"],
  ]) {
    it(`connects ${landing} through hosting and author guides to the source contract`, () => {
      const html = read(landing);
      for (const manual of ["organizer", "problem-author"]) {
        expect(html).toContain(`href="./docs/manual/${manual}/${suffix}"`);
        const guide = read(`landing/docs/manual/${manual}/${suffix || "index.html"}`);
        // Organizer reaches the contract through the quickstart; authors link directly.
        const via =
          manual === "organizer"
            ? read(`landing/docs/getting-started/${suffix || "index.html"}`)
            : guide;
        expect(via).toContain("/docs/operate/use-existing-pack/");
        expect(via).toContain("#catalog-source-schema");
      }
      const contract = read(`landing/docs/operate/use-existing-pack/${suffix || "index.html"}`);
      expect(contract).toContain('id="catalog-source-schema"');
      expect(contract).toContain("scripts/problem-pack/catalog-read.ts");
      expect(contract).toContain("SelectionSchema");
      expect(contract).toContain("make catalog-download CATALOG_SOURCES=./config/my-catalogs.json");
      expect(contract).toContain("../../private-event-problems");
      expect(contract).toContain("scripts/problem-pack/test/local-catalog.test.ts");
    });
  }
  it("provides author-guide targets for both runtime locales, including English HTML shown in Japanese", () => {
    const app = read("landing/app.js");
    for (const key of ["aud.c.moreHref", "extend.cta3Href"]) {
      expect(app).toContain(`"${key}": "./docs/manual/problem-author/"`);
      expect(app).toContain(`"${key}": "./docs/manual/problem-author/index.en.html"`);
    }
  });
  it("provides organizer-guide targets for both runtime locales", () => {
    const app = read("landing/app.js");
    for (const key of ["hero.hostHref", "aud.b.moreHref"]) {
      expect(app).toContain(`"${key}": "./docs/manual/organizer/"`);
      expect(app).toContain(`"${key}": "./docs/manual/organizer/index.en.html"`);
    }
  });
  it("uses existing LLM entry points without claiming automatic enforcement", () => {
    for (const path of ["landing/llms.txt", "landing/llms-full.txt"]) {
      const text = read(path);
      expect(text).toContain("/docs/operate/use-existing-pack/");
      expect(text).toContain("not an automatically enforced agent setting");
      expect(text).toContain("same checkout");
    }
    expect(read("AGENTS.md")).toContain(
      "operate/use-existing-pack/page.ja.mdx#catalog-source-schema",
    );
    expect(read("CLAUDE.md")).toContain("@AGENTS.md");
  });
});

describe("saved enterprise copy integrated onto the current LP", () => {
  it("keeps the six enterprise uses and private inquiry route without restoring removed sections", () => {
    for (const file of ["landing/index.html", "landing/index.en.html"]) {
      const html = read(file);
      const uses = html.match(/<section[^>]*id="use-cases"[\s\S]*?<\/section>/)?.[0];
      expect(uses).toBeDefined();
      for (const key of ["a", "b", "c", "d", "e", "f"]) {
        expect(uses).toContain(`data-i18n="uc.${key}.h"`);
      }
      expect(html).toContain('href="#use-cases"');
      expect(uses).toContain('data-i18n="uc.loop"');
      expect(html).not.toContain('id="onboard"');
      expect(html).not.toContain('id="trust-bullets"');
      expect(html).not.toContain('class="future-learning"');
      const contact = new JSDOM(html).window.document.getElementById("contact")?.outerHTML;
      expect(contact).toContain('href="https://forms.gle/djVprYmq3hFgJA7P9"');
      expect(contact).not.toContain("/discussions");
      // The inquiry form accepts responses without a Google sign-in, so the label must not
      // claim one is required.
      expect(contact).toContain(
        file.endsWith("index.en.html") ? ">Contact form</a>" : ">お問い合わせフォーム</a>",
      );
      expect(contact).not.toMatch(/Google sign-in|Googleログイン/);
      expect(html).toContain('href="/portal-demo/?demo=1&amp;goto=start"');
      expect(html).toContain('data-i18n="extend.idea"');
    }
  });
});
