import type { TopNavigationProps } from "@cloudscape-design/components/top-navigation";
import { describe, expect, it, vi } from "vitest";
import { buildLocaleUtility, isSupportedLocaleId } from "../../src/components/locale-switcher";
import type { LocaleCode } from "../../src/i18n";

/**
 * #1418 SOLID/DRY: AppLayout / TeamSetup で重複していた locale switcher util を 1 箇所へ集約した
 * 共有モジュールの単体テスト。 旧来は 2 ファイルに別々(引数順違い)で定義されていた。
 */

type MenuUtil = Extract<TopNavigationProps.Utility, { type: "menu-dropdown" }>;
const t = (key: string) => key;

describe("isSupportedLocaleId", () => {
  it("should accept a supported locale id and reject an unknown one", () => {
    expect(isSupportedLocaleId("ja")).toBe(true);
    expect(isSupportedLocaleId("zz")).toBe(false);
  });
});

describe("buildLocaleUtility", () => {
  it("should build a globe menu showing the current locale's display name", () => {
    const u = buildLocaleUtility("ja", vi.fn(), t) as MenuUtil;
    expect(u.type).toBe("menu-dropdown");
    expect(u.iconName).toBe("globe");
    expect(u.text).toBe("日本語");
    expect(u.items.map((i) => i.id)).toEqual(["ja", "en"]);
  });

  it("should fall back to the raw code when the locale is not in the dictionary", () => {
    const u = buildLocaleUtility("zz" as LocaleCode, vi.fn(), t) as MenuUtil;
    expect(u.text).toBe("zz");
  });

  it("should call setLocale when a supported item is clicked", () => {
    const setLocale = vi.fn();
    const u = buildLocaleUtility("ja", setLocale, t) as MenuUtil;
    u.onItemClick?.({ detail: { id: "en" } } as never);
    expect(setLocale).toHaveBeenCalledWith("en");
  });

  it("should ignore a click on an unsupported item id", () => {
    const setLocale = vi.fn();
    const u = buildLocaleUtility("ja", setLocale, t) as MenuUtil;
    u.onItemClick?.({ detail: { id: "zz" } } as never);
    expect(setLocale).not.toHaveBeenCalled();
  });
});
