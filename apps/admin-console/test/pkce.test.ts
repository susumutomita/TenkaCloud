import { describe, expect, it } from "vitest";
import { deriveChallenge, generateVerifier } from "../src/auth/pkce";

describe("generateVerifier", () => {
  describe("指定された長さで呼び出したとき", () => {
    it("その長さ（43〜128 の範囲）の文字列を返すべき", () => {
      const verifier = generateVerifier(64);
      expect(verifier.length).toBe(64);
    });

    it("RFC 7636 の文字集合（[A-Za-z0-9\\-._~]）のみを含むべき", () => {
      const verifier = generateVerifier(64);
      expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
    });
  });

  describe("複数回呼び出したとき", () => {
    it("それぞれ異なる値を返すべき", () => {
      const a = generateVerifier();
      const b = generateVerifier();
      expect(a).not.toBe(b);
    });
  });
});

describe("deriveChallenge", () => {
  describe("既知の verifier を渡したとき", () => {
    it("RFC 7636 Appendix B の base64url(SHA-256) を返すべき", async () => {
      const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
      const expected = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
      expect(await deriveChallenge(verifier)).toBe(expected);
    });
  });
});
