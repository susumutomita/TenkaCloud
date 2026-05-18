import { describe, expect, it } from "vitest";
import { generatePkcePair } from "../src/pkce.ts";

describe("generatePkcePair", () => {
  it("verifier は 43 文字の URL-safe base64 (32 byte random) であるべき", () => {
    const { verifier } = generatePkcePair();
    expect(verifier.length).toBe(43); // 32 bytes → 43 chars urlsafe base64 without padding
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("challenge は SHA-256 base64url で 43 文字であるべき", () => {
    const { challenge } = generatePkcePair();
    expect(challenge.length).toBe(43);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("method は S256 であるべき", () => {
    expect(generatePkcePair().method).toBe("S256");
  });

  it("2 回呼ぶと別 pair (= randomness 確認)", () => {
    const a = generatePkcePair();
    const b = generatePkcePair();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).not.toBe(b.challenge);
  });
});
