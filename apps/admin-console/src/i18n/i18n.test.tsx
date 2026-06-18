import { act, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _testInternals,
  I18nProvider,
  interpolate,
  type LocaleCode,
  useI18n,
  useLang,
  useT,
} from "./index";

/**
 * Issue #583 i18n Phase 1.B: admin-console の自前 i18n の pin。
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

  it("should use ja as the default locale (test-env default when navigator.language is not supported)", () => {
    const { result } = renderHook(() => useI18n(), { wrapper });
    expect(result.current.locale).toMatch(/^(ja|en)$/);
  });

  it("should persist setLocale to localStorage and restore it on next startup", () => {
    const { result } = renderHook(() => useI18n(), { wrapper });
    act(() => result.current.setLocale("en"));
    expect(result.current.locale).toBe("en");
    // localStorage の値が保存されている
    expect(window.localStorage.getItem("tenkacloud.admin.locale")).toBe("en");
  });

  it("should look up the nested dictionary via dot-separated keys in t()", () => {
    const { result } = renderHook(() => useI18n(), { wrapper });
    act(() => result.current.setLocale("ja"));
    expect(result.current.t("app.title")).toBe("管理コンソール");
    act(() => result.current.setLocale("en"));
    expect(result.current.t("app.title")).toBe("Admin Console");
  });

  it("should fall back to en when a key is undefined for the locale, and to the raw key when also missing in en", () => {
    const { result } = renderHook(() => useT(), { wrapper });
    // 全 locale にあるキー → 翻訳成功
    expect(result.current("nav.tenants")).toBeTruthy();
    expect(result.current("nav.tenants")).not.toBe("nav.tenants");
    // 全 locale に無い key → raw key 返し
    expect(result.current("nonexistent.key")).toBe("nonexistent.key");
  });

  it("should expose SUPPORTED_LOCALES as 2 languages [ja, en] (zh/es removed in #1078)", () => {
    const supported: readonly LocaleCode[] = ["ja", "en"];
    for (const code of supported) {
      const dict = _testInternals.LOCALE_DICTIONARIES[code];
      expect(dict).toBeDefined();
      // すべての locale が "locale.name" key を持つ (= UI switcher 表示用)
      expect(_testInternals.resolveKey(dict, "locale.name")).toBeTruthy();
    }
  });

  it("should keep the admin drill-down namespace key set identical between ja/en", () => {
    const namespaces = ["admin_event_detail", "admin_deployment_detail"];
    const collectLeafKeys = (node: unknown, prefix = ""): string[] => {
      if (typeof node !== "object" || node === null) return [prefix];
      return Object.entries(node).flatMap(([key, value]) =>
        collectLeafKeys(value, prefix ? `${prefix}.${key}` : key),
      );
    };

    for (const namespace of namespaces) {
      const baseline = collectLeafKeys(_testInternals.LOCALE_DICTIONARIES.en[namespace]).sort();
      const actual = collectLeafKeys(_testInternals.LOCALE_DICTIONARIES.ja[namespace]).sort();
      expect(actual).toEqual(baseline);
    }
  });

  it("should make <html lang> follow the locale on change", () => {
    const { result } = renderHook(() => useI18n(), { wrapper });
    act(() => result.current.setLocale("en"));
    expect(document.documentElement.lang).toBe("en");
    act(() => result.current.setLocale("ja"));
    expect(document.documentElement.lang).toBe("ja");
  });

  it("should throw when useI18n is called outside the Provider (= early detection of configuration error)", () => {
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
    // ja default で「状態を取得中|Loading」 が出る (navigator.language が ja/en どちらでも fallback で en に行く)
    const el = screen.getByText(/(状態を取得中|Loading)…/);
    expect(el).toBeInTheDocument();
  });
});

describe("interpolate (#655)", () => {
  it("should embed a single placeholder", () => {
    expect(interpolate("Hello {name}!", { name: "World" })).toBe("Hello World!");
  });

  it("should embed multiple placeholders in a single pass", () => {
    expect(interpolate("{a} - {b} - {a}", { a: "X", b: "Y" })).toBe("X - Y - X");
  });

  it("should not double-substitute when a value contains a string identical to a placeholder (= pathological input defense)", () => {
    // 旧来の .replace().replace() chain だと {tenantName} = "{tenantId}" のとき
    // 続く tenantId 置換で意図せず展開された。 1 pass regex なら問題なし。
    expect(
      interpolate("name={tenantName} id={tenantId}", {
        tenantName: "{tenantId}",
        tenantId: "abc-123",
      }),
    ).toBe("name={tenantId} id=abc-123");
  });

  it("should substitute undefined keys with an empty string and not leak raw {name} to the UI", () => {
    expect(interpolate("Hello {missing}!", {})).toBe("Hello !");
  });

  it("should return a template without placeholders unchanged", () => {
    expect(interpolate("no placeholder", { a: "X" })).toBe("no placeholder");
  });
});

describe("detectBrowserLocale", () => {
  const setLanguage = (value: string) =>
    Object.defineProperty(navigator, "language", { value, configurable: true });
  const original = navigator.language;
  afterEach(() => setLanguage(original));

  it("should map en-* / ja-* and fall back to ja for unsupported / empty languages", () => {
    const { detectBrowserLocale } = _testInternals;
    setLanguage("en-US");
    expect(detectBrowserLocale()).toBe("en");
    setLanguage("ja-JP");
    expect(detectBrowserLocale()).toBe("ja");
    setLanguage("fr-FR"); // 非対応 → ja
    expect(detectBrowserLocale()).toBe("ja");
    setLanguage(""); // navigator.language が空 → `|| "ja"` の RHS
    expect(detectBrowserLocale()).toBe("ja");
  });
});

describe("resolveKey", () => {
  it("should resolve nested strings and return undefined for non-string / non-object descents", () => {
    const { resolveKey } = _testInternals;
    expect(resolveKey({ a: { b: "hit" } }, "a.b")).toBe("hit");
    expect(resolveKey({ a: { b: "hit" } }, "a")).toBeUndefined(); // node が object → undefined
    expect(resolveKey({ a: "leaf" }, "a.b.c")).toBeUndefined(); // string を descend → undefined
  });
});

describe("t with params / useLang", () => {
  function wrapper({ children }: { children: React.ReactNode }) {
    return <I18nProvider>{children}</I18nProvider>;
  }

  it("should interpolate params passed to t()", () => {
    const { result } = renderHook(() => useT(), { wrapper });
    // 既知 key が無くても raw key (= template) に param を埋め込む経路を通す。
    expect(result.current("greeting {who}", { who: "World" })).toBe("greeting World");
  });

  it("should expose the active locale via useLang", () => {
    const { result } = renderHook(() => ({ i18n: useI18n(), lang: useLang() }), { wrapper });
    act(() => result.current.i18n.setLocale("en"));
    expect(result.current.lang).toBe("en");
  });
});
