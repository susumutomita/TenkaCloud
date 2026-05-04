import { describe, expect, it } from "vitest";
import { toAsciiSlug } from "../../src/lib/slug";

describe("toAsciiSlug", () => {
  it("英数字以外を落とし、lowercase 化するべき", () => {
    expect(toAsciiSlug("Alpha-1!")).toBe("alpha1");
  });

  it("日本語などの非 ASCII 文字は anon にフォールバックするべき", () => {
    expect(toAsciiSlug("日本語キー")).toBe("anon");
  });

  it("空文字なら anon を返すべき", () => {
    expect(toAsciiSlug("")).toBe("anon");
  });

  it("デフォルトで 12 文字に切り詰めるべき", () => {
    expect(toAsciiSlug("A".repeat(50))).toHaveLength(12);
  });

  it("maxLength を渡せばその長さに切り詰めるべき", () => {
    expect(toAsciiSlug("A".repeat(50), 5)).toBe("aaaaa");
  });
});
