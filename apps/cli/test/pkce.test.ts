import { describe, expect, it } from "vitest";
import { generatePkcePair } from "../src/pkce.ts";

describe("generatePkcePair", () => {
  it("should produce a 43-char URL-safe base64 verifier from 32 random bytes", () => {
    const { verifier } = generatePkcePair();
    expect(verifier.length).toBe(43); // 32 bytes → 43 chars urlsafe base64 without padding
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("should produce a 43-char SHA-256 base64url challenge", () => {
    const { challenge } = generatePkcePair();
    expect(challenge.length).toBe(43);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("should use S256 as the method", () => {
    expect(generatePkcePair().method).toBe("S256");
  });

  it("should return a different pair on each call (randomness check)", () => {
    const a = generatePkcePair();
    const b = generatePkcePair();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).not.toBe(b.challenge);
  });
});
