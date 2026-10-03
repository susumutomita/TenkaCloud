import { describe, expect, it } from "vitest";
import {
  HintRevealRecordSchema,
  parseHintRevealedAttribute,
} from "../../lib/problem-deploy/handlers/shared/hint-reveal";

describe("HintRevealRecordSchema (#742 Phase 2)", () => {
  it("hintId / revealedAt / penaltyApplied が揃っていれば valid", () => {
    expect(
      HintRevealRecordSchema.safeParse({
        hintId: "hint-1",
        revealedAt: "2026-05-15T01:00:00.000Z",
        penaltyApplied: 10,
      }).success,
    ).toBe(true);
  });

  it("penaltyApplied は非負整数のみ valid (= 既知 penalty 値の保存、 負値 / float は reject)", () => {
    expect(
      HintRevealRecordSchema.safeParse({
        hintId: "h",
        revealedAt: "t",
        penaltyApplied: -1,
      }).success,
    ).toBe(false);
    expect(
      HintRevealRecordSchema.safeParse({ hintId: "h", revealedAt: "t", penaltyApplied: 1.5 })
        .success,
    ).toBe(false);
    expect(
      HintRevealRecordSchema.safeParse({ hintId: "h", revealedAt: "t", penaltyApplied: 0 }).success,
    ).toBe(true);
  });

  it("hintId / revealedAt の空文字は reject", () => {
    expect(
      HintRevealRecordSchema.safeParse({ hintId: "", revealedAt: "t", penaltyApplied: 5 }).success,
    ).toBe(false);
    expect(
      HintRevealRecordSchema.safeParse({ hintId: "h", revealedAt: "", penaltyApplied: 5 }).success,
    ).toBe(false);
  });
});

describe("parseHintRevealedAttribute (#742 Phase 2)", () => {
  it("undefined / null は空配列に正規化 (= 旧 row 互換)", () => {
    expect(parseHintRevealedAttribute(undefined)).toEqual([]);
    expect(parseHintRevealedAttribute(null)).toEqual([]);
  });

  it("非配列も空配列にフォールバック (= 不正な DDB attribute を破壊しない)", () => {
    expect(parseHintRevealedAttribute("not an array")).toEqual([]);
    expect(parseHintRevealedAttribute({ hintId: "h" })).toEqual([]);
  });

  it("valid 要素のみ抽出、 不正要素は skip (= partial 不正でも全体 reject しない)", () => {
    const result = parseHintRevealedAttribute([
      { hintId: "h1", revealedAt: "t1", penaltyApplied: 5 },
      { hintId: "h2", revealedAt: "t2" }, // penaltyApplied 不在 → skip
      "string item", // 不正 → skip
      { hintId: "h3", revealedAt: "t3", penaltyApplied: -1 }, // negative → schema reject
      { hintId: "h4", revealedAt: "t4", penaltyApplied: 0 },
    ]);
    expect(result).toEqual([
      { hintId: "h1", revealedAt: "t1", penaltyApplied: 5 },
      { hintId: "h4", revealedAt: "t4", penaltyApplied: 0 },
    ]);
  });
});
