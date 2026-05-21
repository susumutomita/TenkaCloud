import { describe, expect, it } from "vitest";
import { toAsciiSlug } from "../../src/lib/slug";

describe("toAsciiSlug", () => {
  it("should drop non-alphanumerics and lowercase the result", () => {
    expect(toAsciiSlug("Alpha-1!")).toBe("alpha1");
  });

  it("should fall back to anon for non-ASCII characters such as Japanese", () => {
    expect(toAsciiSlug("日本語キー")).toBe("anon");
  });

  it("should return anon for empty string", () => {
    expect(toAsciiSlug("")).toBe("anon");
  });

  it("should truncate to 12 characters by default", () => {
    expect(toAsciiSlug("A".repeat(50))).toHaveLength(12);
  });

  it("should truncate to the given length when maxLength is passed", () => {
    expect(toAsciiSlug("A".repeat(50), 5)).toBe("aaaaa");
  });
});
