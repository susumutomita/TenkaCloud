import { describe, expect, it } from "vitest";
import {
  appendHintReveal,
  findHintReveal,
  HintRevealedAttributeSchema,
  HintRevealRecordSchema,
  isHintRevealed,
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

describe("isHintRevealed (#742 Phase 2)", () => {
  it("undefined records は false (= 旧 row 互換)", () => {
    expect(isHintRevealed(undefined, "hint-1")).toBe(false);
  });

  it("空配列は false", () => {
    expect(isHintRevealed([], "hint-1")).toBe(false);
  });

  it("該当 hintId が含まれていれば true", () => {
    const records = [
      { hintId: "hint-1", revealedAt: "t", penaltyApplied: 10 },
      { hintId: "hint-2", revealedAt: "t", penaltyApplied: 20 },
    ];
    expect(isHintRevealed(records, "hint-2")).toBe(true);
    expect(isHintRevealed(records, "hint-3")).toBe(false);
  });
});

describe("findHintReveal (#742 Phase 2)", () => {
  it("該当 record を返すべき", () => {
    const records = [{ hintId: "h1", revealedAt: "t1", penaltyApplied: 5 }];
    expect(findHintReveal(records, "h1")).toEqual({
      hintId: "h1",
      revealedAt: "t1",
      penaltyApplied: 5,
    });
  });

  it("undefined records / 不在 hintId は undefined を返すべき", () => {
    expect(findHintReveal(undefined, "h1")).toBeUndefined();
    expect(findHintReveal([], "h1")).toBeUndefined();
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

describe("appendHintReveal (#742 Phase 2)", () => {
  it("既存 records に新規 hint を append、 changed=true で返す", () => {
    const result = appendHintReveal([{ hintId: "h1", revealedAt: "t1", penaltyApplied: 5 }], {
      hintId: "h2",
      revealedAt: "t2",
      penaltyApplied: 10,
    });
    expect(result.changed).toBe(true);
    expect(result.appended?.hintId).toBe("h2");
    expect(result.records).toHaveLength(2);
  });

  it("undefined existing からの append も changed=true (= 旧 row への初回 reveal)", () => {
    const result = appendHintReveal(undefined, {
      hintId: "h1",
      revealedAt: "t",
      penaltyApplied: 5,
    });
    expect(result.changed).toBe(true);
    expect(result.records).toEqual([{ hintId: "h1", revealedAt: "t", penaltyApplied: 5 }]);
  });

  it("既に reveal 済の hintId は changed=false で no-op (= API の idempotent)", () => {
    const records = [{ hintId: "h1", revealedAt: "t1", penaltyApplied: 5 }];
    const result = appendHintReveal(records, {
      hintId: "h1",
      revealedAt: "t2-different",
      penaltyApplied: 99,
    });
    expect(result.changed).toBe(false);
    expect(result.appended).toBeUndefined();
    // 元 records を変えない (= 既存 penaltyApplied=5 / revealedAt=t1 が保たれる)。
    expect(result.records).toEqual(records);
  });
});

describe("HintRevealedAttributeSchema (#742 Phase 2)", () => {
  it("空配列 valid (= 全 hint 未 reveal の row)", () => {
    expect(HintRevealedAttributeSchema.safeParse([]).success).toBe(true);
  });

  it("複数 valid record の配列 valid", () => {
    expect(
      HintRevealedAttributeSchema.safeParse([
        { hintId: "h1", revealedAt: "t", penaltyApplied: 5 },
        { hintId: "h2", revealedAt: "t", penaltyApplied: 10 },
      ]).success,
    ).toBe(true);
  });
});
