import { afterEach, describe, expect, it, vi } from "vitest";
import { parseProblemsCatalog } from "../../lib/problem-deploy/handlers/shared/catalog";

/**
 * Issue #1424: BATTLE_PROBLEMS_CATALOG env decoder (shared/catalog.ts) は 0% だった。
 * 不在 / 不正 JSON / 非 object / 非 string 値 drop の全分岐を pin する。
 */
afterEach(() => vi.restoreAllMocks());

describe("parseProblemsCatalog", () => {
  it("should return {} for undefined or empty input", () => {
    expect(parseProblemsCatalog(undefined)).toEqual({});
    expect(parseProblemsCatalog("")).toEqual({});
  });

  it("should warn and return {} on invalid JSON", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseProblemsCatalog("{not json")).toEqual({});
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("parse failed"));
  });

  it("should return {} when the JSON is an array or a non-object", () => {
    expect(parseProblemsCatalog("[1,2,3]")).toEqual({});
    expect(parseProblemsCatalog("42")).toEqual({});
    expect(parseProblemsCatalog("null")).toEqual({});
  });

  it("should keep string values and drop non-string values", () => {
    expect(parseProblemsCatalog('{"p1":"battle/p1","p2":42,"p3":"challenge/p3"}')).toEqual({
      p1: "battle/p1",
      p3: "challenge/p3",
    });
  });
});
