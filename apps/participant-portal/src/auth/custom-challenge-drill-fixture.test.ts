import { describe, expect, it } from "vitest";
import { createCustomChallengeDrillFixture } from "./custom-challenge-drill-fixture";

/**
 * 最終ドリルの問題文が、verifier が実際に見ている条件を伝えきれているか。
 *
 * 元の問題文は「golden をコピーして自分のものに書き換える」までしか書いておらず、
 * `scripts/onboarding/verify-custom-challenge.ts` が落とす 8 条件のうち触れていたのは
 * 半分だった。初見の参加者はフォルダ名と `metadata.json` の `id` の一致、`category`、
 * `flagOutputKey` と `Outputs` の対応、golden flag の残存で落ちる。どれも問題文を読んで
 * 気づける情報が無く、verifier のエラーを読んで初めて分かる状態だった。
 *
 * ここで verifier 側の語を直接引いて突き合わせるのは、問題文と検証の乖離が
 * 「エラーを見るまで分からないドリル」に戻る唯一の経路だから。verifier に条件を足したら
 * この配列にも足す — 足さなければ落ちる。
 */

const fixture = createCustomChallengeDrillFixture({
  createdAt: "2026-01-01T00:00:00.000Z",
  expiresAt: 1_800_000_000,
});

/** multi-flag 前提を 1 か所に閉じ込める (scoring / flags は contract 上 optional)。 */
function allHints() {
  const scoring = fixture.scoring;
  if (scoring?.kind !== "multi-flag") return [];
  return (scoring.flags ?? []).flatMap((flag) => flag.hints ?? []);
}

/** 参加者が読める全文 (説明 + 手順 + 全ヒント)、ja / en それぞれ。 */
function proseFor(locale: "ja" | "en"): string {
  const parts =
    locale === "ja"
      ? [fixture.description, fixture.instructions]
      : [fixture.i18n?.en?.description, fixture.i18n?.en?.instructions];
  for (const hint of allHints()) {
    parts.push(locale === "ja" ? hint.content : hint.i18n?.en?.content);
  }
  return parts.filter((part): part is string => typeof part === "string").join("\n");
}

/**
 * `verify-custom-challenge.ts` が落とす条件と、それに気づくために本文へ出ていなければ
 * ならない語。verifier のメッセージそのものではなく、参加者が自分のファイルの中で探す語を
 * 選んでいる (エラー文言は英語だが、日本語話者が探すのはフィールド名なので ja/en 共通)。
 */
const REQUIRED_TOKENS: readonly (readonly [string, string])[] = [
  ["checkProblemSet: hello-world を残す", "hello-world"],
  ["checkIdentity: ディレクトリ = id", "problems/challenges/"],
  ["checkMetadata: category", "category"],
  ["checkMetadata: scoring.kind = flag", "scoring.kind"],
  ["checkMetadata: flagOutputKey", "flagOutputKey"],
  ["checkMetadata: runtime を触らない", "runtime"],
  ["checkTemplate: Outputs に対応させる", "Outputs"],
  ["checkTemplate: golden flag を消す", "TENKA{golden-reference-flag}"],
];

describe("createCustomChallengeDrillFixture", () => {
  it.each(["ja", "en"] as const)("should have prose to check in %s", (locale) => {
    // 以下の toContain 群は本文が空でも通ってしまう。
    expect(proseFor(locale).length).toBeGreaterThan(500);
  });

  describe.each(["ja", "en"] as const)("%s prose", (locale) => {
    it.each(REQUIRED_TOKENS)("should tell the author about %s", (_label, token) => {
      expect(proseFor(locale)).toContain(token);
    });
  });

  it("should give the worked example command rather than only describing it", () => {
    // 「golden をコピーする」だけでは、どこへ置くのかが本文から決まらない。
    for (const locale of ["ja", "en"] as const) {
      expect(proseFor(locale)).toContain(
        "packs/golden/basic-aws-pack/problems/challenges/find-the-flag",
      );
      expect(proseFor(locale)).toContain("onboarding:verify-custom-challenge");
    }
  });

  it("should keep every hint penalty-free, as the description promises", () => {
    const hints = allHints();
    expect(hints.length).toBeGreaterThan(0);
    for (const hint of hints) expect(hint.penalty).toBe(0);
  });

  it("should translate every hint, so the en drill is not half Japanese", () => {
    const hints = allHints();
    expect(hints.length).toBeGreaterThan(0);
    for (const hint of hints) {
      expect(hint.i18n?.en?.content, `${hint.id} has no en content`).toBeTruthy();
    }
  });
});
