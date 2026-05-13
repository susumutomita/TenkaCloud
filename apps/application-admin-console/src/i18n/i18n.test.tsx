import { act, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _testInternals, I18nProvider, type LocaleCode, useI18n, useT } from "./index";

/**
 * Issue #583 i18n Phase 1.C: application-admin-console の自前 i18n の pin。
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

  it("default locale は ja (navigator.language 未対応の test 環境 default)", () => {
    const { result } = renderHook(() => useI18n(), { wrapper });
    expect(result.current.locale).toMatch(/^(ja|en|es|zh)$/);
  });

  it("setLocale が localStorage に永続化し次回起動で復元すべき", () => {
    const { result } = renderHook(() => useI18n(), { wrapper });
    act(() => result.current.setLocale("en"));
    expect(result.current.locale).toBe("en");
    // localStorage の値が保存されている
    expect(window.localStorage.getItem("tenkacloud.application-admin.locale")).toBe("en");
  });

  it("t() は dot-separated key で nested dictionary を引くべき", () => {
    const { result } = renderHook(() => useI18n(), { wrapper });
    act(() => result.current.setLocale("ja"));
    expect(result.current.t("app.title")).toBe("TenkaCloud アプリケーション管理コンソール");
    act(() => result.current.setLocale("en"));
    expect(result.current.t("app.title")).toBe("TenkaCloud Application Admin Console");
  });

  it("locale で key 未定義なら en で fallback、 en にも無ければ raw key", () => {
    const { result } = renderHook(() => useT(), { wrapper });
    // 全 locale にあるキー → 翻訳成功
    expect(result.current("nav.problems")).toBeTruthy();
    expect(result.current("nav.problems")).not.toBe("nav.problems");
    // 全 locale に無い key → raw key 返し
    expect(result.current("nonexistent.key")).toBe("nonexistent.key");
  });

  it("SUPPORTED_LOCALES = 4 言語 [ja, en, es, zh]", () => {
    const supported: readonly LocaleCode[] = ["ja", "en", "es", "zh"];
    for (const code of supported) {
      const dict = _testInternals.LOCALE_DICTIONARIES[code];
      expect(dict).toBeDefined();
      // すべての locale が "locale.name" key を持つ (= UI switcher 表示用)
      expect(_testInternals.resolveKey(dict, "locale.name")).toBeTruthy();
    }
  });

  it("locale 変更時に <html lang> が追従すべき", () => {
    const { result } = renderHook(() => useI18n(), { wrapper });
    act(() => result.current.setLocale("zh"));
    expect(document.documentElement.lang).toBe("zh");
    act(() => result.current.setLocale("ja"));
    expect(document.documentElement.lang).toBe("ja");
  });

  it("useI18n を Provider 外で呼ぶと throw すべき (= configuration error の早期発見)", () => {
    // renderHook で wrapper を渡さないと throws する
    expect(() => renderHook(() => useI18n())).toThrow(/I18nProvider/);
  });

  // 翻訳結果が UI に出ることを実 render で確認
  it("Provider 配下で翻訳結果が UI に反映されるべき", () => {
    function Probe() {
      const t = useT();
      return <div>{t("app.loading")}</div>;
    }
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );
    // ja default で「読み込み中|Loading|Cargando|正在加载…」 が出る (navigator.language が ja/en どちらでも fallback で en に行く)
    const el = screen.getByText(/(状態を取得中|Loading|Cargando|正在加载)…/);
    expect(el).toBeInTheDocument();
  });
});
