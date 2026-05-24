import { describe, expect, it } from "vitest";
import { deriveChallenge, generateVerifier } from "../src/pkce";

const BASE64URL_CHARSET = /^[A-Za-z0-9_-]+$/;

describe("generateVerifier", () => {
  it("should produce a verifier of the requested length using the unreserved charset", () => {
    const verifier = generateVerifier(64);
    expect(verifier).toHaveLength(64);
    expect(BASE64URL_CHARSET.test(verifier)).toBe(true);
  });

  it("should produce a different verifier on each call (cryptographic randomness)", () => {
    const a = generateVerifier();
    const b = generateVerifier();
    expect(a).not.toBe(b);
  });

  it("should default to a 64-character verifier when no length is given", () => {
    expect(generateVerifier()).toHaveLength(64);
  });

  it("should honor explicit shorter lengths (state-token use case, length=32)", () => {
    const state = generateVerifier(32);
    expect(state).toHaveLength(32);
    expect(BASE64URL_CHARSET.test(state)).toBe(true);
  });
});

describe("deriveChallenge", () => {
  it("should match the RFC 7636 reference vector for base64url(SHA-256(verifier))", async () => {
    // RFC 7636 Appendix B reference: verifier "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
    // -> challenge "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    const challenge = await deriveChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
    expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("should produce a base64url string with no padding characters", async () => {
    const challenge = await deriveChallenge(generateVerifier());
    expect(BASE64URL_CHARSET.test(challenge)).toBe(true);
    expect(challenge).not.toContain("=");
    expect(challenge).not.toContain("+");
    expect(challenge).not.toContain("/");
  });
});
