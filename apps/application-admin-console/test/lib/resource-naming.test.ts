import { describe, expect, it } from "vitest";
import { buildStackPrefix, slugify } from "../../src/lib/resource-naming";

describe("slugify", () => {
  it("英数字以外をハイフンに置換するべき", () => {
    expect(slugify("Alpha Team")).toBe("alpha-team");
    expect(slugify("Team_42!")).toBe("team-42");
  });

  it("先頭末尾の連続ハイフンを刈るべき", () => {
    expect(slugify("---hello---")).toBe("hello");
    expect(slugify("___under___")).toBe("under");
  });

  it("大文字を全部小文字化するべき", () => {
    expect(slugify("ALPHA")).toBe("alpha");
  });

  it("40 文字を超えたら truncate するべき", () => {
    const long = "a".repeat(60);
    expect(slugify(long)).toHaveLength(40);
  });

  it("空文字でも例外を出さず空を返すべき", () => {
    expect(slugify("")).toBe("");
  });
});

describe("buildStackPrefix", () => {
  it("`tc-{problemSlug}-{teamSlug}` を組み立てるべき", () => {
    expect(buildStackPrefix("security-battle-royale", "Alpha Team")).toBe(
      "tc-security-battle-royale-alpha-team",
    );
  });

  it("同一 problem でも team が違えば異なる prefix を返すべき (collision 回避の根拠)", () => {
    const a = buildStackPrefix("p", "team-a");
    const b = buildStackPrefix("p", "team-b");
    expect(a).not.toBe(b);
  });

  it("空 team でも prefix としては成立するべき (validation は呼び出し側責務)", () => {
    expect(buildStackPrefix("p1", "")).toBe("tc-p1-");
  });
});
