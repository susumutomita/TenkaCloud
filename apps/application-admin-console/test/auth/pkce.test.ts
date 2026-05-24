// Issue #1246: re-targets the shared @tenkacloud/auth-client (formerly src/auth/pkce).
import { deriveChallenge, generateVerifier } from "@tenkacloud/auth-client";
import { describe, expect, it } from "vitest";

describe("generateVerifier", () => {
  describe("when called with a specified length", () => {
    it("should return a string of that length (within the 43-128 range)", () => {
      const verifier = generateVerifier(64);
      expect(verifier.length).toBe(64);
    });

    it("should contain only the RFC 7636 character set ([A-Za-z0-9\\-._~])", () => {
      const verifier = generateVerifier(64);
      expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
    });
  });

  describe("when called multiple times", () => {
    it("should return different values each time", () => {
      const a = generateVerifier();
      const b = generateVerifier();
      expect(a).not.toBe(b);
    });
  });
});

describe("deriveChallenge", () => {
  describe("when given a known verifier", () => {
    it("should return the base64url(SHA-256) from RFC 7636 Appendix B", async () => {
      const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
      const expected = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
      expect(await deriveChallenge(verifier)).toBe(expected);
    });
  });
});
