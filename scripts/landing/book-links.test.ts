import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The book links, in every surface that carries them (#2971).
 *
 * The failure this exists to catch is not a broken URL — it is **half an update**. The
 * book exists in two editions on two different stores, and the link appears in six
 * places across two languages. Change the Leanpub slug and the Japanese README, the
 * Japanese landing page and `llms.txt` keep pointing at the old one; nothing renders
 * wrong, nothing fails to build, and the only symptom is a reader landing somewhere
 * that no longer sells the book.
 *
 * So the URLs live here once, and every surface is checked against them.
 *
 * What this deliberately does not do is fetch the URLs. A test that reaches two
 * commercial storefronts on every CI run fails when Leanpub has a bad minute, which
 * teaches people to re-run the suite until it passes — the same lesson
 * `check-course-drift.ts` records for its own `unreachable` rows.
 */

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const read = (path: string) => readFileSync(join(REPO_ROOT, path), "utf8");

/**
 * Collapse newlines so a prose assertion is not really an assertion about where the
 * author happened to wrap the line. Re-wrapping a paragraph is not a regression.
 */
const prose = (path: string) => read(path).replace(/\s+/g, " ");

const JA_BOOK = "https://zenn.dev/bull/books/cloud-competition";
const EN_BOOK = "https://leanpub.com/build-your-own-cloud-competition";

/** Every file that must carry both editions, whatever its own language is. */
const BILINGUAL_SURFACES = [
  "README.md",
  "README.ja.md",
  "landing/llms.txt",
  "landing/llms-full.txt",
  "apps/developer-portal/src/app/developers/docs/getting-started/page.mdx",
  "apps/developer-portal/src/app/developers/docs/getting-started/page.ja.mdx",
];

describe("書籍導線 (#2971)", () => {
  it.each(BILINGUAL_SURFACES)("%s は日英どちらの版へも到達できる", (surface) => {
    // 片方だけ載っている状態を許すと、その面の読者は自分の言語の版に辿り着けない。
    const text = read(surface);
    expect(text, `${surface} に日本語版へのリンクがない`).toContain(JA_BOOK);
    expect(text, `${surface} に英語版へのリンクがない`).toContain(EN_BOOK);
  });

  /** The one footer anchor, whose href app.js swaps per locale. */
  function footerBookLink(surface: string): string {
    const line = read(surface)
      .split("\n")
      .find((candidate) => candidate.includes('data-i18n="footer.r3"'));
    expect(line, `${surface} に footer.r3 の書籍リンクがない`).toBeDefined();
    return line as string;
  }

  it("フッターの 1 リンクは、既定言語のまま読める版を指す", () => {
    // 出荷される file の既定値だけを見る。実際に表示される販売先は app.js が
    // 閲覧者のロケールで差し替えるので、これは runtime の挙動の証明ではない
    // (それは下の test が扱う)。ここが守るのは「JS が動かなかったとき、または
    // ロケール検出の前に見えている href」が読めない版を指さないこと。
    //
    // 対象は footer の 1 リンクに限る。以前はページ全体を見ていたが、それは
    // 「ページ上に 1 版しか出てこない」ことまで固定してしまっていた。両版を
    // 並べて出す #book セクション (下の test) はその制約の下では書けない。
    expect(footerBookLink("landing/index.html")).toContain(JA_BOOK);
    expect(footerBookLink("landing/index.html")).not.toContain(EN_BOOK);
    expect(footerBookLink("landing/index.en.html")).toContain(EN_BOOK);
    expect(footerBookLink("landing/index.en.html")).not.toContain(JA_BOOK);
  });

  it.each([
    ["landing/index.html"],
    ["landing/index.en.html"],
  ])("%s の書籍セクションは、両方の版を並べて出す", (surface) => {
    // Issue #2974 の実質。フッターの 1 行だけだった頃は、日本語ページからは
    // Zenn 版しか、英語ページからは Leanpub 版しか見えず、読者から見て
    // 「自分の言語の版しか存在しない」ように読めていた。並べるのが目的なので、
    // 両方あることと、どちらがどの言語かが書かれていることを固定する。
    const text = read(surface);
    const section = text.slice(text.indexOf('<section id="book">'));
    expect(section, `${surface} に #book セクションがない`).toContain("</section>");
    const body = section.slice(0, section.indexOf("</section>"));
    expect(body, `${surface} の書籍セクションに日本語版がない`).toContain(JA_BOOK);
    expect(body, `${surface} の書籍セクションに英語版がない`).toContain(EN_BOOK);
    // 言語表示は data-i18n で差し替わるので、キーの存在で固定する。URL だけ
    // 並べても、どちらが自分の読める版かは分からない。
    expect(body).toContain('data-i18n="book.jaLang"');
    expect(body).toContain('data-i18n="book.enLang"');
  });

  it("app.js は href も翻訳対象として両方の URL を持つ", () => {
    // 文言だけ翻訳して href を共通にすると、生成される英語ページが日本語の販売先を指す。
    const app = read("landing/app.js");
    expect(app).toContain(`"footer.r3Href": "${JA_BOOK}"`);
    expect(app).toContain(`"footer.r3Href": "${EN_BOOK}"`);
  });

  it("app.js のロケール切り替えが、閲覧言語に合う販売先へ差し替える", () => {
    // 2026-08-09 に実ブラウザ (Chromium) で測った結果を契約として固定する。
    //
    //   /                    locale ja-JP -> Zenn
    //   /                    locale en-US -> Leanpub
    //   /?lang=ja            locale en-US -> Zenn      (明示指定が勝つ)
    //   /index.en.html       locale ja-JP -> Leanpub   (英語ページは英語のまま)
    //
    // つまり販売先は file ではなく読者の言語に従う。翻訳表からどちらかの
    // href が消えると、その言語の読者が読めない版へ送られる。
    const app = read("landing/app.js");
    const jaBlock = app.slice(app.indexOf('"footer.r3Href"'));
    expect(jaBlock.startsWith(`"footer.r3Href": "${JA_BOOK}"`)).toBe(true);
    const enIndex = app.indexOf('"footer.r3Href"', app.indexOf('"footer.r3Href"') + 1);
    expect(enIndex).toBeGreaterThan(0);
    expect(app.slice(enIndex).startsWith(`"footer.r3Href": "${EN_BOOK}"`)).toBe(true);
  });

  it("書籍が現行仕様の正本ではないことを、どの面でも明示する", () => {
    // 「本に書いてあった」で古い挙動を主張されると、書籍への導線が負債になる。
    // 表現は面ごとに違ってよいが、リポジトリ側が正本だという趣旨は落とさない。
    const claims: [string, RegExp][] = [
      ["README.md", /source of truth for how it currently works/i],
      ["README.ja.md", /現行仕様の正本はこのリポジトリ/],
      ["landing/llms.txt", /not\*\* a specification/i],
      ["landing/llms-full.txt", /not\*\* a specification/i],
      [
        "apps/developer-portal/src/app/developers/docs/getting-started/page.mdx",
        /source of truth for current behaviour/i,
      ],
      [
        "apps/developer-portal/src/app/developers/docs/getting-started/page.ja.mdx",
        /現行の挙動の正本はこのドキュメント/,
      ],
    ];
    for (const [surface, pattern] of claims) {
      expect(prose(surface), `${surface} に書籍の位置づけの断りがない`).toMatch(pattern);
    }
  });
});
