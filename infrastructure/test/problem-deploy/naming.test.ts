import { describe, expect, it } from "vitest";
import { buildStackPrefix, slugify } from "../../lib/problem-deploy/handlers/deploy-handler/naming";

describe("backend naming (frontend と同じ規約)", () => {
  it("buildStackPrefix は `tc-{problemSlug}-{teamSlug}` を返すべき", () => {
    expect(buildStackPrefix("security-battle-royale", "Alpha Team")).toBe(
      "tc-security-battle-royale-alpha-team",
    );
  });

  it("slugify は英数字以外をハイフンに変換するべき", () => {
    expect(slugify("Alpha Team!")).toBe("alpha-team");
  });

  it("先頭末尾の連続ハイフンを刈るべき", () => {
    expect(slugify("---hello---")).toBe("hello");
  });

  it("40 文字を超えたら truncate するべき", () => {
    expect(slugify("a".repeat(60))).toHaveLength(40);
  });

  it("空文字なら空文字を返すべき (validation は呼び出し側責務)", () => {
    expect(slugify("")).toBe("");
  });
});
