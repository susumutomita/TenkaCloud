import { describe, expect, it } from "vitest";
import { isCognitoDomain, isHttpsUrl } from "../src/runtime-config";

describe("isHttpsUrl (Issue #871)", () => {
  it("should accept an https URL", () => {
    expect(isHttpsUrl("https://api.example.com")).toBe(true);
  });

  it("should reject http URLs (mixed content / MITM defense)", () => {
    expect(isHttpsUrl("http://api.example.com")).toBe(false);
  });

  it("should reject malformed URLs without throwing", () => {
    expect(isHttpsUrl("not a url")).toBe(false);
    expect(isHttpsUrl("")).toBe(false);
  });
});

describe("isCognitoDomain (Issue #871)", () => {
  it("should accept https URLs hosted under .amazoncognito.com", () => {
    expect(isCognitoDomain("https://tenant.auth.ap-northeast-1.amazoncognito.com")).toBe(true);
  });

  it("should reject https URLs on unrelated hosts (Cognito allowlist)", () => {
    expect(isCognitoDomain("https://evil.example.com")).toBe(false);
  });

  it("should reject http URLs even when the host matches", () => {
    expect(isCognitoDomain("http://tenant.auth.ap-northeast-1.amazoncognito.com")).toBe(false);
  });

  it("should reject malformed URLs without throwing", () => {
    expect(isCognitoDomain("garbled")).toBe(false);
  });
});
