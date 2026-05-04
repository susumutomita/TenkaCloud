import { describe, expect, it } from "vitest";
import { decodeIdToken } from "../../src/auth/jwt";

function base64UrlEncode(obj: Record<string, unknown>): string {
  const json = JSON.stringify(obj);
  const base64 = btoa(json);
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function buildToken(payload: Record<string, unknown>): string {
  const header = base64UrlEncode({ alg: "RS256", typ: "JWT" });
  const body = base64UrlEncode(payload);
  const signature = "sig"; // 検証しないので dummy
  return `${header}.${body}.${signature}`;
}

describe("decodeIdToken", () => {
  describe("Cognito id_token 相当の payload を含む JWT を渡したとき", () => {
    it("email と custom:tenantId を抽出できるべき", () => {
      const token = buildToken({
        sub: "user-1",
        email: "a@b.com",
        "custom:tenantId": "tenant-123",
      });
      const claims = decodeIdToken(token);
      expect(claims).not.toBeNull();
      expect(claims?.email).toBe("a@b.com");
      expect(claims?.tenantId).toBe("tenant-123");
    });
  });

  describe("payload に custom:tenantId が無いとき", () => {
    it("tenantId は undefined、email は返るべき", () => {
      const token = buildToken({ email: "a@b.com" });
      const claims = decodeIdToken(token);
      expect(claims?.email).toBe("a@b.com");
      expect(claims?.tenantId).toBeUndefined();
    });
  });

  describe("JWT の段数が 3 で無いとき", () => {
    it("null を返すべき", () => {
      expect(decodeIdToken("header.body")).toBeNull();
      expect(decodeIdToken("single")).toBeNull();
    });
  });

  describe("payload が JSON で無いとき", () => {
    it("null を返すべき (例外を投げない)", () => {
      // 有効 base64 だけど JSON で無い
      const malformed = `aaaa.${btoa("not json")}.sig`;
      expect(decodeIdToken(malformed)).toBeNull();
    });
  });
});
