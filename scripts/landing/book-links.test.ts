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

  it("ランディングページは閲覧言語に合う販売先を主導線にする", () => {
    // 日本語ページから Leanpub へ送る (またはその逆) と、読めない版へ送ることになる。
    // `index.en.html` は生成物なので、ここが落ちるときは app.js の翻訳か生成漏れ。
    expect(read("landing/index.html")).toContain(JA_BOOK);
    expect(read("landing/index.html")).not.toContain(EN_BOOK);
    expect(read("landing/index.en.html")).toContain(EN_BOOK);
    expect(read("landing/index.en.html")).not.toContain(JA_BOOK);
  });

  it("app.js は href も翻訳対象として両方の URL を持つ", () => {
    // 文言だけ翻訳して href を共通にすると、生成される英語ページが日本語の販売先を指す。
    const app = read("landing/app.js");
    expect(app).toContain(`"footer.r3Href": "${JA_BOOK}"`);
    expect(app).toContain(`"footer.r3Href": "${EN_BOOK}"`);
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
