import { describe, expect, it } from "vitest";
import { digestOfOwnSource, sha256Hex, toDigestRef } from "../src/digest.js";

describe("sha256Hex", () => {
  it("should be deterministic for the same content", () => {
    expect(sha256Hex("hello")).toBe(sha256Hex("hello"));
  });

  it("should differ for different content", () => {
    expect(sha256Hex("hello")).not.toBe(sha256Hex("hello!"));
  });

  it("should match a known SHA-256 vector", () => {
    // echo -n "hello" | sha256sum
    expect(sha256Hex("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });
});

describe("toDigestRef", () => {
  it("should prefix a hex digest with the sha256: scheme", () => {
    expect(toDigestRef("abc123")).toBe("sha256:abc123");
  });
});

describe("digestOfOwnSource", () => {
  it("should return a stable sha256: reference for the calling module's own file", () => {
    const digest = digestOfOwnSource(import.meta.url);
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(digestOfOwnSource(import.meta.url)).toBe(digest);
  });
});
