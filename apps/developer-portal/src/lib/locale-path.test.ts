import { describe, expect, it } from "vitest";
import { localeOf, mirrorPath } from "./locale-path";

describe("localeOf", () => {
  it("should treat the JA home and JA routes as ja", () => {
    expect(localeOf("/")).toBe("ja");
    expect(localeOf("/catalog/")).toBe("ja");
    expect(localeOf("/developers/docs/getting-started/")).toBe("ja");
  });

  it("should treat the EN home and EN routes as en", () => {
    expect(localeOf("/en/")).toBe("en");
    expect(localeOf("/en/catalog/")).toBe("en");
  });

  it("should normalize a missing trailing slash and an empty path", () => {
    expect(localeOf("/en")).toBe("en");
    expect(localeOf("")).toBe("ja");
  });
});

describe("mirrorPath", () => {
  it("should map each bilingual JA route to its EN mirror", () => {
    expect(mirrorPath("/")).toBe("/en/");
    expect(mirrorPath("/catalog/")).toBe("/en/catalog/");
    expect(mirrorPath("/privacy/")).toBe("/en/privacy/");
    expect(mirrorPath("/terms/")).toBe("/en/terms/");
    expect(mirrorPath("/legal/")).toBe("/en/legal/");
  });

  it("should map each bilingual EN route back to its JA mirror", () => {
    expect(mirrorPath("/en/")).toBe("/");
    expect(mirrorPath("/en/catalog/")).toBe("/catalog/");
    expect(mirrorPath("/en/legal/")).toBe("/legal/");
  });

  it("should fall back to the other locale home for unmirrored routes", () => {
    expect(mirrorPath("/developers/")).toBe("/en/");
    expect(mirrorPath("/product/")).toBe("/en/");
    expect(mirrorPath("/en/developers/docs/")).toBe("/");
  });

  it("should normalize a missing trailing slash before mapping", () => {
    expect(mirrorPath("/catalog")).toBe("/en/catalog/");
    expect(mirrorPath("/en/catalog")).toBe("/catalog/");
  });
});
