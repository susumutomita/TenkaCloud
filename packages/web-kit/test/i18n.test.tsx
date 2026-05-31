import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createI18n, interpolate, resolveKey } from "../src/i18n";

/**
 * Issue #1418 (web-kit Stage 2): createI18n factory + 純 helper (interpolate / resolveKey) の
 * 全分岐を pin する (SSR guard は v8-ignore 済だが挙動も exercise する)。
 */
const STORAGE_KEY = "test.web-kit.locale";
const dictionaries = {
  ja: { app: { title: "タイトル" }, greet: "こんにちは {name}" },
  en: { app: { title: "Title" }, greet: "Hello {name}", only_en: "EN only" },
} as const;
type L = "ja" | "en";
const makeKit = () =>
  createI18n<L>({
    dictionaries,
    supportedLocales: ["ja", "en"],
    defaultLocale: "ja",
    fallbackLocale: "en",
    storageKey: STORAGE_KEY,
  });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("interpolate", () => {
  it("should return the template unchanged with no params", () => {
    expect(interpolate("hello")).toBe("hello");
  });
  it("should substitute named placeholders and stringify numbers", () => {
    expect(interpolate("hi {name}, you have {n}", { name: "Ada", n: 3 })).toBe(
      "hi Ada, you have 3",
    );
  });
  it("should leave a placeholder intact when its param is undefined", () => {
    expect(interpolate("{a} {b}", { a: "x" })).toBe("x {b}");
  });
});

describe("resolveKey", () => {
  it("should resolve a nested dot key", () => {
    expect(resolveKey(dictionaries.ja, "app.title")).toBe("タイトル");
  });
  it("should return undefined for a missing key", () => {
    expect(resolveKey(dictionaries.ja, "app.missing")).toBeUndefined();
  });
  it("should return undefined when a path segment is not an object", () => {
    expect(resolveKey(dictionaries.ja, "greet.deeper")).toBeUndefined();
  });
});

describe("createI18n internals", () => {
  it("detectBrowserLocale should narrow navigator.language and default to defaultLocale", () => {
    const { detectBrowserLocale } = makeKit().internals;
    vi.stubGlobal("navigator", { language: "ja-JP" });
    expect(detectBrowserLocale()).toBe("ja");
    vi.stubGlobal("navigator", { language: "en-US" });
    expect(detectBrowserLocale()).toBe("en");
    vi.stubGlobal("navigator", { language: "fr-FR" });
    expect(detectBrowserLocale()).toBe("ja");
    vi.stubGlobal("navigator", { language: "" });
    expect(detectBrowserLocale()).toBe("ja");
    vi.stubGlobal("navigator", undefined);
    expect(detectBrowserLocale()).toBe("ja");
  });

  it("loadStoredLocale should accept a valid code and reject others / errors / SSR", () => {
    const { loadStoredLocale } = makeKit().internals;
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
    expect(loadStoredLocale()).toBeUndefined();
  });

  it("persistLocale should write to localStorage and swallow errors / SSR", () => {
    const { persistLocale } = makeKit().internals;
    persistLocale("en");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("en");
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => persistLocale("ja")).not.toThrow();
    spy.mockRestore();
    vi.stubGlobal("window", undefined);
    expect(() => persistLocale("ja")).not.toThrow();
  });
});

describe("I18nProvider + hooks", () => {
  // jsdom の navigator.language は "en-US" 既定なので、 ja-default を期待する test では
  // navigator を ja に固定する (stored-locale が無いケースの detect 経路を決定的にする)。
  beforeEach(() => vi.stubGlobal("navigator", { language: "ja-JP" }));

  const wrapper = (kit: ReturnType<typeof makeKit>) => {
    const { I18nProvider } = kit;
    return ({ children }: { children: ReactNode }) => <I18nProvider>{children}</I18nProvider>;
  };

  it("should look up the active locale, fall back to fallbackLocale, then the raw key", () => {
    const kit = makeKit();
    const { result } = renderHook(() => kit.useT(), { wrapper: wrapper(kit) });
    expect(result.current("app.title")).toBe("タイトル"); // ja hit
    expect(result.current("only_en")).toBe("EN only"); // ja miss → en fallback
    expect(result.current("nope.key")).toBe("nope.key"); // both miss → raw key
    expect(result.current("greet", { name: "Ada" })).toBe("こんにちは Ada"); // interpolation
  });

  it("should expose the locale via useLang and switch + persist via setLocale", () => {
    const kit = makeKit();
    const { result } = renderHook(() => kit.useI18n(), { wrapper: wrapper(kit) });
    expect(result.current.locale).toBe("ja");
    act(() => result.current.setLocale("en"));
    expect(result.current.locale).toBe("en");
    expect(result.current.t("app.title")).toBe("Title");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("en");
  });

  it("useLang should return the active locale", () => {
    const kit = makeKit();
    const { result } = renderHook(() => kit.useLang(), { wrapper: wrapper(kit) });
    expect(result.current).toBe("ja");
  });

  it("should initialize from a stored locale when present", () => {
    localStorage.setItem(STORAGE_KEY, "en");
    const kit = makeKit();
    const { result } = renderHook(() => kit.useLang(), { wrapper: wrapper(kit) });
    expect(result.current).toBe("en");
  });

  it("useI18n should throw outside a provider", () => {
    const kit = makeKit();
    expect(() => renderHook(() => kit.useI18n())).toThrow(/must be called inside/);
  });
});
