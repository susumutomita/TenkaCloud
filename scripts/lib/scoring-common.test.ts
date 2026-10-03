import { describe, expect, it } from "bun:test";
import { joinUrl } from "./scoring-common";

describe("joinUrl (relocated from health-check-handler)", () => {
  it("should return base as-is when path is empty", () => {
    expect(joinUrl("https://x.example.com", "")).toBe("https://x.example.com");
  });

  it("should normalize the double slash between trailing / on base and leading / on path", () => {
    expect(joinUrl("https://x.example.com/", "/foo")).toBe("https://x.example.com/foo");
  });

  it("should insert a / between base without trailing / and path without leading /", () => {
    expect(joinUrl("https://x.example.com", "foo")).toBe("https://x.example.com/foo");
  });

  it("should use the path as-is when it is an absolute URL (override)", () => {
    expect(joinUrl("https://x.example.com", "https://other.example.com/health")).toBe(
      "https://other.example.com/health",
    );
  });

  it("normal case (base without trailing / + path with leading /) should join as base/path", () => {
    expect(joinUrl("https://x.example.com", "/healthz")).toBe("https://x.example.com/healthz");
  });
});
