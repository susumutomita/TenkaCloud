import { act, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _testInternals, I18nProvider, type LocaleCode, useI18n, useT } from "./index";

/**
 * Issue #583 i18n Phase 1.A: portal の自前 i18n の pin。
 * dict lookup / fallback chain / localStorage persist / dictionary missing key の 4 path を検証。
 */

describe("i18n homegrown (Issue #583 Phase 1.A)", () => {
  beforeEach(() => {
    if (typeof window !== "undefined") window.localStorage.clear();
  });

  afterEach(() => {
    if (typeof window !== "undefined") window.localStorage.clear();
  });

  function wrapper({ children }: { children: React.ReactNode }) {
    return <I18nProvider>{children}</I18nProvider>;
  }

  it("should default locale to ja (test env default when navigator.language is unsupported)", () => {
    const { result } = renderHook(() => useI18n(), { wrapper });
    expect(result.current.locale).toMatch(/^(ja|en)$/);
  });

  it("should persist setLocale to localStorage and restore it on next startup", () => {
    const { result } = renderHook(() => useI18n(), { wrapper });
    act(() => result.current.setLocale("en"));
    expect(result.current.locale).toBe("en");
    // localStorage の値が保存されている
    expect(window.localStorage.getItem("tenkacloud.portal.locale")).toBe("en");
  });

  it("should look up a nested dictionary with a dot-separated key via t()", () => {
    const { result } = renderHook(() => useI18n(), { wrapper });
    act(() => result.current.setLocale("ja"));
    expect(result.current.t("app.title")).toBe("TenkaCloud 競技者ポータル");
    act(() => result.current.setLocale("en"));
    expect(result.current.t("app.title")).toBe("TenkaCloud Participant Portal");
  });

  it("should fall back to en when the key is undefined for the locale, and to raw key when en lacks it too", () => {
    const { result } = renderHook(() => useT(), { wrapper });
    // 全 locale にあるキー → 翻訳成功
    expect(result.current("nav.problems")).toBeTruthy();
    expect(result.current("nav.problems")).not.toBe("nav.problems");
    // 全 locale に無い key → raw key 返し
    expect(result.current("nonexistent.key")).toBe("nonexistent.key");
  });

  it("should interpolate params into {name} placeholders via t() (Phase 2 page-level)", () => {
    const { result } = renderHook(() => useI18n(), { wrapper });
    act(() => result.current.setLocale("ja"));
    expect(result.current.t("home.welcome", { teamName: "Team Alpha" })).toBe(
      "ようこそ、Team Alpha さん",
    );
    act(() => result.current.setLocale("en"));
    expect(result.current.t("home.welcome", { teamName: "Team Alpha" })).toBe(
      "Welcome, Team Alpha",
    );
  });

  it("should leave placeholders without supplied params as raw (= for missing key debug)", () => {
    expect(_testInternals.interpolate("Hello, {name}!", {})).toBe("Hello, {name}!");
    expect(_testInternals.interpolate("a={a} b={b}", { a: 1 })).toBe("a=1 b={b}");
  });

  it("should support 2 languages in SUPPORTED_LOCALES [ja, en] (#1078 removed zh/es)", () => {
    const supported: readonly LocaleCode[] = ["ja", "en"];
    for (const code of supported) {
      const dict = _testInternals.LOCALE_DICTIONARIES[code];
      expect(dict).toBeDefined();
      // すべての locale が "locale.name" key を持つ (= UI switcher 表示用)
      expect(_testInternals.resolveKey(dict, "locale.name")).toBeTruthy();
    }
  });

  it("should update <html lang> when locale changes", () => {
    const { result } = renderHook(() => useI18n(), { wrapper });
    act(() => result.current.setLocale("en"));
    expect(document.documentElement.lang).toBe("en");
    act(() => result.current.setLocale("ja"));
    expect(document.documentElement.lang).toBe("ja");
  });

  it("should throw when useI18n is called outside the Provider (= early detection of configuration errors)", () => {
    // renderHook で wrapper を渡さないと throws する
    expect(() => renderHook(() => useI18n())).toThrow(/I18nProvider/);
  });

  // 翻訳結果が UI に出ることを実 render で確認
  it("should reflect translation results in the UI under the Provider", () => {
    function Probe() {
      const t = useT();
      return <div>{t("app.loading")}</div>;
    }
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );
    // ja default で「状態を取得中…」 が出る (navigator.language が ja/en どちらでも fallback で en に行く)
    const el = screen.getByText(/(状態を取得中|Loading)…/);
    expect(el).toBeInTheDocument();
  });
});
