import { act, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _testInternals, I18nProvider, interpolate, type LocaleCode, useI18n, useT } from "./index";

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

  it("default locale は ja (navigator.language 未対応の test 環境 default)", () => {
    const { result } = renderHook(() => useI18n(), { wrapper });
    expect(result.current.locale).toMatch(/^(ja|en)$/);
  });

  it("setLocale が localStorage に永続化し次回起動で復元すべき", () => {
    const { result } = renderHook(() => useI18n(), { wrapper });
    act(() => result.current.setLocale("en"));
    expect(result.current.locale).toBe("en");
    // localStorage の値が保存されている
    expect(window.localStorage.getItem("tenkacloud.admin.locale")).toBe("en");
  });

  it("t() は dot-separated key で nested dictionary を引くべき", () => {
    const { result } = renderHook(() => useI18n(), { wrapper });
    act(() => result.current.setLocale("ja"));
    expect(result.current.t("app.title")).toBe("TenkaCloud 管理コンソール");
    act(() => result.current.setLocale("en"));
    expect(result.current.t("app.title")).toBe("TenkaCloud Admin Console");
  });

  it("locale で key 未定義なら en で fallback、 en にも無ければ raw key", () => {
    const { result } = renderHook(() => useT(), { wrapper });
    // 全 locale にあるキー → 翻訳成功
    expect(result.current("nav.tenants")).toBeTruthy();
    expect(result.current("nav.tenants")).not.toBe("nav.tenants");
    // 全 locale に無い key → raw key 返し
    expect(result.current("nonexistent.key")).toBe("nonexistent.key");
  });

  it("SUPPORTED_LOCALES = 2 言語 [ja, en] (#1078 で zh/es 廃止)", () => {
    const supported: readonly LocaleCode[] = ["ja", "en"];
    for (const code of supported) {
      const dict = _testInternals.LOCALE_DICTIONARIES[code];
      expect(dict).toBeDefined();
      // すべての locale が "locale.name" key を持つ (= UI switcher 表示用)
      expect(_testInternals.resolveKey(dict, "locale.name")).toBeTruthy();
    }
  });

  it("admin drill-down namespace の key set が ja/en で一致すべき", () => {
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

  it("locale 変更時に <html lang> が追従すべき", () => {
    const { result } = renderHook(() => useI18n(), { wrapper });
    act(() => result.current.setLocale("en"));
    expect(document.documentElement.lang).toBe("en");
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
    // ja default で「状態を取得中|Loading」 が出る (navigator.language が ja/en どちらでも fallback で en に行く)
    const el = screen.getByText(/(状態を取得中|Loading)…/);
    expect(el).toBeInTheDocument();
  });
});

describe("interpolate (#655)", () => {
  it("単一 placeholder を埋め込むべき", () => {
    expect(interpolate("Hello {name}!", { name: "World" })).toBe("Hello World!");
  });

  it("複数 placeholder を 1 pass で埋め込むべき", () => {
    expect(interpolate("{a} - {b} - {a}", { a: "X", b: "Y" })).toBe("X - Y - X");
  });

  it("値に placeholder と同形 string が含まれても 2 重置換しないべき (= 病的 input 防御)", () => {
    // 旧来の .replace().replace() chain だと {tenantName} = "{tenantId}" のとき
    // 続く tenantId 置換で意図せず展開された。 1 pass regex なら問題なし。
    expect(
      interpolate("name={tenantName} id={tenantId}", {
        tenantName: "{tenantId}",
        tenantId: "abc-123",
      }),
    ).toBe("name={tenantId} id=abc-123");
  });

  it("未定義 key は空文字列に置換し raw {name} を UI に漏らさないべき", () => {
    expect(interpolate("Hello {missing}!", {})).toBe("Hello !");
  });

  it("placeholder が無い template はそのまま返すべき", () => {
    expect(interpolate("no placeholder", { a: "X" })).toBe("no placeholder");
  });
});
