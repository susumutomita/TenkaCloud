import { describe, expect, it } from "vitest";
import { externalPortalUrl, problemProvider, providerLabel } from "../../src/data/providers";

describe("providers (#2233)", () => {
  it("should map canonical providers to brand labels", () => {
    expect(providerLabel("aws")).toBe("AWS");
    expect(providerLabel("sakura")).toBe("Sakura Cloud");
    expect(providerLabel("azure")).toBe("Azure");
    expect(providerLabel("gcp")).toBe("Google Cloud");
  });

  it("should fall back to the raw value for an unknown provider", () => {
    expect(providerLabel("oraclecloud")).toBe("oraclecloud");
  });

  it("should not resolve labels through the prototype chain", () => {
    // Record 直引きだと "toString" 等で Object.prototype の関数が返ってしまう。
    expect(providerLabel("toString")).toBe("toString");
    expect(providerLabel("constructor")).toBe("constructor");
  });

  it("should default a legacy view without provider to aws", () => {
    expect(problemProvider({})).toBe("aws");
  });

  it("should fold an empty provider to aws like the backend resolver", () => {
    expect(problemProvider({ provider: "" })).toBe("aws");
  });

  it("should echo an explicit provider", () => {
    expect(problemProvider({ provider: "sakura" })).toBe("sakura");
  });

  it("should map external-portal providers to their public console URLs", () => {
    // Issue #2235: プラットフォーム所有の定数マップ (metadata / 参加者入力からは供給しない)。
    expect(externalPortalUrl("gcp")).toBe("https://console.cloud.google.com/");
    expect(externalPortalUrl("azure")).toBe("https://portal.azure.com/");
    expect(externalPortalUrl("sakura")).toBe("https://secure.sakura.ad.jp/cloud/");
  });

  it("should return no external portal for aws (managed console path)", () => {
    expect(externalPortalUrl("aws")).toBeUndefined();
  });

  it("should return no external portal for an unknown provider", () => {
    expect(externalPortalUrl("oraclecloud")).toBeUndefined();
  });

  it("should not resolve external portal URLs through the prototype chain", () => {
    expect(externalPortalUrl("toString")).toBeUndefined();
    expect(externalPortalUrl("constructor")).toBeUndefined();
  });
});
