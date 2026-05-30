import { describe, expect, it } from "vitest";
import type { ProblemCatalogEntry } from "../../src/data/problems";
import { resolveLocalizedNarrative } from "../../src/data/problems";

/**
 * resolveLocalizedNarrative の fallback chain: 指定 locale override → ja 正本。
 * ja / i18n 不在 / [locale] 不在 / 完全 override / 部分 override (= field 単位 fallback) を pin。
 * ProblemDetail.test 側ではこの関数を mock しているため、 実体はここで直接突く。
 */
const entry = (i18n?: ProblemCatalogEntry["i18n"]): ProblemCatalogEntry =>
  ({
    name: "JA Name",
    shortDescription: "JA short",
    learningGoals: ["JA goal"],
    i18n,
  }) as unknown as ProblemCatalogEntry;

describe("resolveLocalizedNarrative", () => {
  it("should return the top-level (ja) narrative for locale ja", () => {
    expect(resolveLocalizedNarrative(entry({ en: { name: "EN" } }), "ja")).toEqual({
      name: "JA Name",
      shortDescription: "JA short",
      learningGoals: ["JA goal"],
    });
  });

  it("should return the top-level narrative for en when there is no i18n block", () => {
    expect(resolveLocalizedNarrative(entry(undefined), "en").name).toBe("JA Name");
  });

  it("should return the top-level narrative for en when the en override is absent", () => {
    expect(resolveLocalizedNarrative(entry({}), "en").shortDescription).toBe("JA short");
  });

  it("should use the full en override when present", () => {
    const e = entry({
      en: { name: "EN Name", shortDescription: "EN short", learningGoals: ["EN goal"] },
    });
    expect(resolveLocalizedNarrative(e, "en")).toEqual({
      name: "EN Name",
      shortDescription: "EN short",
      learningGoals: ["EN goal"],
    });
  });

  it("should fall back per-field to ja when the en override omits a field", () => {
    // override は存在するが name / learningGoals が無い → `?? entry.x` の RHS 経路。
    const e = entry({ en: { shortDescription: "EN short only" } });
    expect(resolveLocalizedNarrative(e, "en")).toEqual({
      name: "JA Name",
      shortDescription: "EN short only",
      learningGoals: ["JA goal"],
    });
  });
});
