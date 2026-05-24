import { describe, expect, it } from "vitest";
import { CANONICAL_MOCK_FLAG, EASTER_EGGS, evaluateMockFlag } from "../../src/dev-mock/flag-submit";

describe("evaluateMockFlag", () => {
  it("should accept the canonical flag exactly", () => {
    expect(evaluateMockFlag(CANONICAL_MOCK_FLAG, 800)).toEqual({
      kind: "ok",
      scoreDelta: 800,
      totalScore: 800,
    });
  });

  it("should accept case-insensitive variants", () => {
    expect(evaluateMockFlag("TENKACLOUDSAMPLE", 800).kind).toBe("ok");
    expect(evaluateMockFlag("TenkaCloudSample", 800).kind).toBe("ok");
  });

  it("should accept a strict prefix of the canonical (= typo 寛容)", () => {
    expect(evaluateMockFlag("tenkacloud", 800).kind).toBe("ok");
    expect(evaluateMockFlag("tenka", 800).kind).toBe("ok");
  });

  it("should accept a string that contains the canonical", () => {
    expect(evaluateMockFlag("prefix-tenkacloudsample-suffix", 800).kind).toBe("ok");
  });

  it.each(EASTER_EGGS)("should accept easter egg %s", (egg) => {
    expect(evaluateMockFlag(egg, 800).kind).toBe("ok");
  });

  it.each([
    "wrong",
    "xxx",
    "test",
    "12345",
    "hello world",
    "  ",
  ])("should reject obvious wrong / unrelated input %p", (input) => {
    const result = evaluateMockFlag(input, 800);
    expect(result.kind).toBe("wrong");
    if (result.kind === "wrong") {
      expect(result.scoreDelta).toBe(-10);
      expect(result.wrongCount).toBe(1);
    }
  });

  it("should reject empty input", () => {
    expect(evaluateMockFlag("", 800).kind).toBe("wrong");
  });

  it("should preserve the points value passed in (= ok path uses it)", () => {
    const r = evaluateMockFlag(CANONICAL_MOCK_FLAG, 1234);
    expect(r).toEqual({ kind: "ok", scoreDelta: 1234, totalScore: 1234 });
  });
});
