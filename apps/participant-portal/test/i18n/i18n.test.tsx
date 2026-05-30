import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _testInternals,
  I18nProvider,
  SUPPORTED_LOCALES,
  useI18n,
  useLang,
  useT,
} from "../../src/i18n";

/**
 * Issue #583 i18n 基盤。 純 helper (detectBrowserLocale / loadStoredLocale / persistLocale /
 * resolveKey / interpolate) を _testInternals 経由で全分岐 (= SSR guard / locale fallback /
 * localStorage 例外) 走査し、 Provider + useT/useLang/useI18n/setLocale を renderHook で pin する。
 */
const { detectBrowserLocale, loadStoredLocale, persistLocale, resolveKey, interpolate } =
  _testInternals;
const STORAGE_KEY = "tenkacloud.portal.locale";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("detectBrowserLocale", () => {
  it("should narrow navigator.language and default to ja", () => {
    vi.stubGlobal("navigator", { language: "ja-JP" });
    expect(detectBrowserLocale()).toBe("ja");
    vi.stubGlobal("navigator", { language: "en-US" });
    expect(detectBrowserLocale()).toBe("en");
    vi.stubGlobal("navigator", { language: "fr-FR" });
    expect(detectBrowserLocale()).toBe("ja"); // no match
    vi.stubGlobal("navigator", { language: "" });
    expect(detectBrowserLocale()).toBe("ja"); // empty → "ja"
    vi.stubGlobal("navigator", undefined);
    expect(detectBrowserLocale()).toBe("ja"); // SSR guard
  });
});

describe("loadStoredLocale", () => {
  it("should return a valid stored locale, undefined otherwise / on error / without window", () => {
    localStorage.setItem(STORAGE_KEY, "en");
    expect(loadStoredLocale()).toBe("en");
    localStorage.setItem(STORAGE_KEY, "klingon");
    expect(loadStoredLocale()).toBeUndefined();
    localStorage.removeItem(STORAGE_KEY);
    expect(loadStoredLocale()).toBeUndefined();

    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(loadStoredLocale()).toBeUndefined();
    spy.mockRestore();

    vi.stubGlobal("window", undefined);
    expect(loadStoredLocale()).toBeUndefined(); // SSR guard
  });
});

describe("persistLocale", () => {
  it("should write, swallow errors, and no-op without window", () => {
    persistLocale("en");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("en");

    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => persistLocale("ja")).not.toThrow();
    spy.mockRestore();

    vi.stubGlobal("window", undefined);
    expect(() => persistLocale("ja")).not.toThrow(); // SSR guard
  });
});

describe("resolveKey", () => {
  it("should resolve a leaf string, and return undefined for a non-string node / missing path", () => {
    expect(resolveKey({ a: { b: "x" } }, "a.b")).toBe("x");
    expect(resolveKey({ a: { b: "x" } }, "a")).toBeUndefined(); // node is an object
    expect(resolveKey({ a: { b: "x" } }, "a.c.d")).toBeUndefined(); // missing
  });
});

describe("interpolate", () => {
  it("should leave the template untouched without params and substitute named placeholders", () => {
    expect(interpolate("hi")).toBe("hi");
    expect(interpolate("hi {name}", { name: "Al" })).toBe("hi Al");
    // 未指定 placeholder はそのまま残す (= missing key debug 用)。
    expect(interpolate("hi {name}", { other: "x" })).toBe("hi {name}");
  });
});

describe("I18nProvider + hooks", () => {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <I18nProvider>{children}</I18nProvider>
  );

  it("should translate a real key and fall back to the raw key when missing", () => {
    const { result } = renderHook(() => useT(), { wrapper });
    expect(result.current("definitely.not.a.real.key.zzz")).toBe("definitely.not.a.real.key.zzz");
    // 実在 key (= app.loading) は raw key と異なる翻訳を返す。
    expect(result.current("app.loading")).not.toBe("app.loading");
  });

  it("should expose the current locale via useLang", () => {
    const { result } = renderHook(() => useLang(), { wrapper });
    expect(SUPPORTED_LOCALES).toContain(result.current);
  });

  it("should update + persist the locale via setLocale", () => {
    const { result } = renderHook(() => useI18n(), { wrapper });
    act(() => result.current.setLocale("en"));
    expect(result.current.locale).toBe("en");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("en");
  });

  it("should throw when used outside the provider", () => {
    expect(() => renderHook(() => useI18n())).toThrow(/I18nProvider/);
  });
});
