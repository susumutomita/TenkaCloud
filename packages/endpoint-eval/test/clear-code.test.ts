import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type ClearCodeClaims, issueClearCode, verifyClearCode } from "../src/clear-code.js";

const SECRET = "test-signing-secret";
const claims: ClearCodeClaims = {
  runId: "run-123",
  challengeId: "cloudflare-api-security-001",
  stage: "0-deploy",
  issuedAt: 1_000,
  expiresAt: 10_000,
  nonce: "nonce-abc",
};

describe("issueClearCode / verifyClearCode", () => {
  it("should round-trip a freshly issued code", () => {
    const token = issueClearCode(claims, SECRET);
    const r = verifyClearCode(token, SECRET, 5_000);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.claims).toEqual(claims);
  });

  it("should reject a token signed with a different secret", () => {
    const token = issueClearCode(claims, SECRET);
    const r = verifyClearCode(token, "wrong-secret", 5_000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("署名");
  });

  it("should reject an expired token", () => {
    const token = issueClearCode(claims, SECRET);
    const r = verifyClearCode(token, SECRET, 20_000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("有効期限");
  });

  it("should reject a malformed token (wrong segment count)", () => {
    expect(verifyClearCode("only-one-part", SECRET, 5_000).ok).toBe(false);
    expect(verifyClearCode("a.b.c", SECRET, 5_000).ok).toBe(false);
    expect(verifyClearCode(".", SECRET, 5_000).ok).toBe(false);
  });

  it("should reject a tampered payload (signature no longer matches)", () => {
    const token = issueClearCode(claims, SECRET);
    const [, sig] = token.split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify({ ...claims, stage: "4-final" }),
      "utf8",
    ).toString("base64url");
    const r = verifyClearCode(`${forgedPayload}.${sig}`, SECRET, 5_000);
    expect(r.ok).toBe(false);
  });

  it("should reject a signature of a different length (timing-safe compare guard)", () => {
    const token = issueClearCode(claims, SECRET);
    const [payload] = token.split(".");
    const r = verifyClearCode(`${payload}.short`, SECRET, 5_000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("署名");
  });

  it("should reject a correctly-signed but non-JSON payload", () => {
    // 鍵が漏れたとき相当: 署名は通るが payload が JSON でないケースの防御を確認する。
    const payloadB64 = Buffer.from("not-json", "utf8").toString("base64url");
    const sig = createHmac("sha256", SECRET).update(payloadB64).digest("base64url");
    const r = verifyClearCode(`${payloadB64}.${sig}`, SECRET, 5_000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("復号");
  });
});
