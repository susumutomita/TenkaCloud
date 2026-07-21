import { beforeEach, describe, expect, it } from "vitest";
import { loadMockSolvedFlagIds, saveMockSolvedFlagId } from "./progress-store";

/**
 * dev-mock 進捗 store (2026-07-21 デモ報告「解いたのに開き直すとクリアされてる」の
 * 再発防止)。 sessionStorage 破損 / 不可でも throw しないことまで pin する。
 */
describe("dev-mock progress store", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it("should return an empty set when nothing has been saved", () => {
    expect(loadMockSolvedFlagIds("what-is-tenkacloud").size).toBe(0);
  });

  it("should persist solved flag ids per problem and restore them", () => {
    saveMockSolvedFlagId("what-is-tenkacloud", "tenka-what");
    saveMockSolvedFlagId("what-is-tenkacloud", "battle-challenge");
    saveMockSolvedFlagId("play-local-mode", "portal-port");
    expect([...loadMockSolvedFlagIds("what-is-tenkacloud")].sort()).toEqual([
      "battle-challenge",
      "tenka-what",
    ]);
    expect([...loadMockSolvedFlagIds("play-local-mode")]).toEqual(["portal-port"]);
  });

  it("should deduplicate a flag saved twice", () => {
    saveMockSolvedFlagId("what-is-tenkacloud", "tenka-what");
    saveMockSolvedFlagId("what-is-tenkacloud", "tenka-what");
    expect(loadMockSolvedFlagIds("what-is-tenkacloud").size).toBe(1);
  });

  it("should treat corrupted storage payloads as empty", () => {
    const key = "TenkaCloud.participant.devMockSolvedFlags";
    for (const corrupted of ["not-json", '["array"]', '{"p": "not-an-array"}', '{"p": [1, 2]}']) {
      window.sessionStorage.setItem(key, corrupted);
      const solved = loadMockSolvedFlagIds("p");
      // 数値混じり配列は string 要素だけ残す。 それ以外の破損は空扱い。
      expect([...solved].every((id) => typeof id === "string")).toBe(true);
      expect(solved.has("never-saved")).toBe(false);
    }
  });

  it("should not throw when storage access fails", () => {
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(loadMockSolvedFlagIds("p", throwing).size).toBe(0);
    expect(() => saveMockSolvedFlagId("p", "f", throwing)).not.toThrow();
  });
});
