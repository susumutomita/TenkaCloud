import { afterEach, describe, expect, it } from "vitest";
import { _testInternals, interpolate } from "../src/i18n";

/**
 * i18n の純関数 (detectBrowserLocale / resolveKey / interpolate) の枝を pin する。
 * Provider 側 (t fallback / setLocale / useI18n) はアプリ全体の render で既に網羅済みのため、
 * ここでは branch gap の残り (navigator.language fallback / 非一致 locale / 非 string 解決 /
 * 欠落 placeholder) を直接突く。
 */
const { detectBrowserLocale, resolveKey } = _testInternals;

const setLanguage = (value: string) => {
  Object.defineProperty(navigator, "language", { value, configurable: true });
};
const originalLanguage = navigator.language;
afterEach(() => setLanguage(originalLanguage));

describe("detectBrowserLocale", () => {
  it("should return en for an en-* browser language", () => {
    setLanguage("en-US");
    expect(detectBrowserLocale()).toBe("en");
  });

  it("should return ja for a ja-* browser language", () => {
    setLanguage("ja-JP");
    expect(detectBrowserLocale()).toBe("ja");
  });

  it("should fall back to ja for an unsupported browser language", () => {
    setLanguage("fr-FR");
    expect(detectBrowserLocale()).toBe("ja");
  });

  it("should fall back to ja when navigator.language is empty", () => {
    // `navigator.language || "ja"` の RHS 経路。
    setLanguage("");
    expect(detectBrowserLocale()).toBe("ja");
  });
});

describe("resolveKey", () => {
  it("should resolve a nested string key", () => {
    expect(resolveKey({ a: { b: "hello" } }, "a.b")).toBe("hello");
  });

  it("should return undefined when the resolved node is not a string", () => {
    // a は object → typeof node === "string" が false → undefined。
    expect(resolveKey({ a: { b: "hello" } }, "a")).toBeUndefined();
  });

  it("should return undefined when descending past a non-object node", () => {
    expect(resolveKey({ a: "leaf" }, "a.b.c")).toBeUndefined();
  });
});

describe("interpolate", () => {
  it("should return the template unchanged when there are no params", () => {
    expect(interpolate("plain text")).toBe("plain text");
  });

  it("should substitute provided params", () => {
    expect(interpolate("Hello {name}", { name: "Bob" })).toBe("Hello Bob");
  });

  it("should leave an unmatched placeholder verbatim", () => {
    // params に該当 key が無い → match (= "{missing}") をそのまま残す。
    expect(interpolate("Hi {missing}", { other: "x" })).toBe("Hi {missing}");
  });
});
