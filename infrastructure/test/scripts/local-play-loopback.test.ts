import { describe, expect, it } from "vitest";
import { isLoopbackUrl, parseLoopbackUrl } from "../../../scripts/local-play/loopback";

describe("local-play loopback guard", () => {
  it("should accept http(s) loopback hosts", () => {
    for (const url of [
      "http://127.0.0.1:18081/verify",
      "http://localhost:8080",
      "https://localhost:8443/admin",
      "http://[::1]:9000",
    ]) {
      expect(isLoopbackUrl(url)).toBe(true);
      expect(parseLoopbackUrl(url).hostname).not.toBe("");
    }
  });

  it("should reject non-loopback hosts and non-http schemes", () => {
    for (const url of [
      "http://evil.example.com/verify",
      "http://169.254.169.254/latest/meta-data",
      "https://10.0.0.5/verify",
      "ftp://localhost/x",
      "file:///etc/passwd",
    ]) {
      expect(isLoopbackUrl(url)).toBe(false);
      expect(() => parseLoopbackUrl(url, "verifyUrl")).toThrow(/Refusing non-loopback verifyUrl/);
    }
  });

  it("should fail loudly on an unparseable URL", () => {
    expect(isLoopbackUrl("not a url")).toBe(false);
    expect(() => parseLoopbackUrl("not a url", "verifyUrl")).toThrow(
      /verifyUrl is not a valid URL/,
    );
  });
});
