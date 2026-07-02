import { describe, expect, it } from "vitest";
import { problemProvider, providerLabel } from "../../src/data/providers";

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

  it("should default a view without provider to aws (legacy contract)", () => {
    expect(problemProvider({})).toBe("aws");
  });

  it("should fold an empty provider to aws like the backend resolver", () => {
    expect(problemProvider({ provider: "" })).toBe("aws");
  });

  it("should echo an explicit provider", () => {
    expect(problemProvider({ provider: "sakura" })).toBe("sakura");
  });
});
