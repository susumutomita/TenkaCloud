import type { TopNavigationProps } from "@cloudscape-design/components/top-navigation";
import { type LocaleCode, SUPPORTED_LOCALES } from "../i18n";

type Translate = (key: string) => string;

/**
 * locale code → 表示名。 AppLayout / TeamSetup で重複定義されていた literal を 1 箇所へ集約
 * (#1418 SOLID/DRY)。 SUPPORTED_LOCALES と同期する。
 */
const LOCALE_DICTIONARIES_NAME: Record<LocaleCode, string> = {
  ja: "日本語",
  en: "English",
};

/** menu-dropdown の item id が対応 locale か (= 不正 id で setLocale しない型ガード)。 */
export function isSupportedLocaleId(id: string): id is LocaleCode {
  return (SUPPORTED_LOCALES as readonly string[]).includes(id);
}

/**
 * TopNavigation の言語切替 dropdown utility を組む共有 util。 以前は AppLayout と TeamSetup が
 * **別々に**(しかも引数順違いで)定義しており、 呼び間違いの footgun になっていたため、
 * 中立な module に 1 本化した (引数順は `(locale, setLocale, t)` に統一)。
 */
export function buildLocaleUtility(
  locale: LocaleCode,
  setLocale: (locale: LocaleCode) => void,
  t: Translate,
): TopNavigationProps.Utility {
  return {
    type: "menu-dropdown",
    iconName: "globe",
    ariaLabel: t("switcher.aria_label"),
    text: LOCALE_DICTIONARIES_NAME[locale] ?? locale,
    items: SUPPORTED_LOCALES.map((code) => ({
      id: code,
      // SUPPORTED_LOCALES は dict と同期済なので ?? 右辺は型安全用の不到達分岐。
      /* v8 ignore next */
      text: LOCALE_DICTIONARIES_NAME[code] ?? code,
    })),
    onItemClick: ({ detail }) => {
      if (isSupportedLocaleId(detail.id)) setLocale(detail.id);
    },
  };
}
