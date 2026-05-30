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
  describe("when given a JWT containing a Cognito id_token-equivalent payload", () => {
    it("should extract email and custom:tenantId", () => {
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

  describe("when payload has no custom:tenantId", () => {
    it("should return undefined tenantId but still return email", () => {
      const token = buildToken({ email: "a@b.com" });
      const claims = decodeIdToken(token);
      expect(claims?.email).toBe("a@b.com");
      expect(claims?.tenantId).toBeUndefined();
    });
  });

  describe("when payload has no (string) email", () => {
    it("should return undefined email but still resolve tenantId", () => {
      // email field 不在 のとき email を undefined に倒す防御分岐。
      const token = buildToken({ "custom:tenantId": "tenant-123" });
      const claims = decodeIdToken(token);
      expect(claims?.email).toBeUndefined();
      expect(claims?.tenantId).toBe("tenant-123");
    });
  });

  describe("when JWT does not have 3 segments", () => {
    it("should return null", () => {
      expect(decodeIdToken("header.body")).toBeNull();
      expect(decodeIdToken("single")).toBeNull();
    });
  });

  describe("when payload is not JSON", () => {
    it("should return null (without throwing)", () => {
      // 有効 base64 だけど JSON で無い
      const malformed = `aaaa.${btoa("not json")}.sig`;
      expect(decodeIdToken(malformed)).toBeNull();
    });
  });
});
