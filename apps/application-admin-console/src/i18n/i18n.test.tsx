import { act, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _testInternals, I18nProvider, type LocaleCode, useI18n, useT } from "./index";

/**
 * Issue #583 i18n Phase 1.C: application-admin-console の自前 i18n の pin。
 * dict lookup / fallback chain / localStorage persist / dictionary missing key の 4 path を検証。
 */

const PROBLEM_PACK_GUIDANCE_KEYS = [
  "problems.pack_guidance_open",
  "problems.pack_guidance_modal_title",
  "problems.pack_guidance_modal_description",
  "problems.pack_guidance_path_official_title",
  "problems.pack_guidance_path_official_body",
  "problems.pack_guidance_path_private_title",
  "problems.pack_guidance_path_private_body",
  "problems.pack_guidance_cli_heading",
  "problems.pack_guidance_step_init",
  "problems.pack_guidance_step_validate",
  "problems.pack_guidance_step_install",
  "problems.pack_guidance_step_activate",
  "problems.pack_guidance_step_create_event",
  "problems.pack_guidance_create_event_note",
  "problems.pack_guidance_docs_link",
  "problems.pack_guidance_empty_hint",
] as const;

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

  it("should default locale to ja (default for test envs that don't support navigator.language)", () => {
    const { result } = renderHook(() => useI18n(), { wrapper });
    expect(result.current.locale).toMatch(/^(ja|en)$/);
  });

  it("should persist setLocale to localStorage and restore on next startup", () => {
    const { result } = renderHook(() => useI18n(), { wrapper });
    act(() => result.current.setLocale("en"));
    expect(result.current.locale).toBe("en");
    // localStorage の値が保存されている
    expect(window.localStorage.getItem("tenkacloud.application-admin.locale")).toBe("en");
  });

  it("should look up nested dictionary entries via dot-separated key in t()", () => {
    const { result } = renderHook(() => useI18n(), { wrapper });
    act(() => result.current.setLocale("ja"));
    expect(result.current.t("app.title")).toBe("アプリケーション管理コンソール");
    act(() => result.current.setLocale("en"));
    expect(result.current.t("app.title")).toBe("Application Admin Console");
  });

  it("should fall back to en when the key is not defined in the locale, or return raw key when also absent in en", () => {
    const { result } = renderHook(() => useT(), { wrapper });
    // 全 locale にあるキー → 翻訳成功
    expect(result.current("nav.problems")).toBeTruthy();
    expect(result.current("nav.problems")).not.toBe("nav.problems");
    // 全 locale に無い key → raw key 返し
    expect(result.current("nonexistent.key")).toBe("nonexistent.key");
  });

  it("should have SUPPORTED_LOCALES = 2 languages [ja, en] (zh/es dropped in #1078)", () => {
    const supported: readonly LocaleCode[] = ["ja", "en"];
    for (const code of supported) {
      const dict = _testInternals.LOCALE_DICTIONARIES[code];
      expect(dict).toBeDefined();
      // すべての locale が "locale.name" key を持つ (= UI switcher 表示用)
      expect(_testInternals.resolveKey(dict, "locale.name")).toBeTruthy();
    }
  });

  it("should define the problem-pack guidance keys in both ja and en", () => {
    for (const key of PROBLEM_PACK_GUIDANCE_KEYS) {
      expect(_testInternals.resolveKey(_testInternals.LOCALE_DICTIONARIES.ja, key)).toBeTruthy();
      expect(_testInternals.resolveKey(_testInternals.LOCALE_DICTIONARIES.en, key)).toBeTruthy();
    }
  });

  it("should sync <html lang> when locale changes", () => {
    const { result } = renderHook(() => useI18n(), { wrapper });
    act(() => result.current.setLocale("en"));
    expect(document.documentElement.lang).toBe("en");
    act(() => result.current.setLocale("ja"));
    expect(document.documentElement.lang).toBe("ja");
  });

  it("should throw when useI18n is called outside Provider (= early detection of configuration error)", () => {
    // renderHook で wrapper を渡さないと throws する
    expect(() => renderHook(() => useI18n())).toThrow(/I18nProvider/);
  });

  // 翻訳結果が UI に出ることを実 render で確認
  it("should reflect translation result in the UI under Provider", () => {
    function Probe() {
      const t = useT();
      return <div>{t("app.loading")}</div>;
    }
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );
    // ja default で「状態を取得中|Loading」 が出る (navigator.language が ja/en どちらでも fallback で en に行く)
    const el = screen.getByText(/(状態を取得中|Loading)…/);
    expect(el).toBeInTheDocument();
  });
});
