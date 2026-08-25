import { describe, expect, it } from "vitest";
import { redactSecrets } from "../src/secret-redaction.js";

describe("redactSecrets", () => {
  it("should redact a JSON authorization field value while keeping the field name and surrounding structure", () => {
    const input = JSON.stringify({ headers: { authorization: "token-a" } });
    const { redacted, redactedCount } = redactSecrets(input);
    expect(redacted).not.toContain("token-a");
    expect(redacted).toContain('"authorization":"[REDACTED]"');
    expect(redactedCount).toBeGreaterThan(0);
  });

  it("should redact a raw Authorization header line", () => {
    const input = "Authorization: Bearer abc123XYZ\r\nHost: example.com";
    const { redacted } = redactSecrets(input);
    expect(redacted).not.toContain("abc123XYZ");
    expect(redacted).toContain("Host: example.com");
  });

  it("should redact Set-Cookie / Cookie header values", () => {
    const { redacted: r1 } = redactSecrets("Set-Cookie: session=deadbeef; Path=/");
    expect(r1).not.toContain("deadbeef");
    const { redacted: r2 } = redactSecrets("Cookie: sid=abcdef");
    expect(r2).not.toContain("abcdef");
  });

  it("should redact password/apiKey/token/sessionId/privateKey JSON fields", () => {
    const input = JSON.stringify({
      // eslint-disable-next-line sonarjs/no-hardcoded-passwords -- fixture value for a redaction test, never a real credential
      password: "hunter2",
      apiKey: "sk-live-abc",
      token: "tok-123",
      sessionId: "sess-xyz",
      privateKey: "-----BEGIN KEY-----",
    });
    const { redacted } = redactSecrets(input);
    for (const secret of ["hunter2", "sk-live-abc", "tok-123", "sess-xyz", "-----BEGIN KEY-----"]) {
      expect(redacted).not.toContain(secret);
    }
  });

  it("should leave content with no secret-shaped substrings unchanged", () => {
    const input = "GET /documents/doc-b1 -> 200 Bob private note B1";
    const { redacted, redactedCount } = redactSecrets(input);
    expect(redacted).toBe(input);
    expect(redactedCount).toBe(0);
  });

  it("should never throw on arbitrary input", () => {
    expect(() => redactSecrets("")).not.toThrow();
    expect(() => redactSecrets("{{{not json at all")).not.toThrow();
  });
});
