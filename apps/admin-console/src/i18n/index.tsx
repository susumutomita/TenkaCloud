/**
 * Issue #583 i18n Phase 1.B / #1418 web-kit Stage 2: admin-console の i18n。
 *
 * detect → localStorage 永続化 → nested-key lookup → en fallback → interpolate という core は
 * 3 SPA 共通だったため、 `@tenkacloud/web-kit` の `createI18n` factory に集約済み。 ここは
 * 「locale dictionary (locales/*.json) + storage key + interpolate policy を注入して factory を
 * 呼ぶ」 だけの thin shim で、 公開 API (I18nProvider / useI18n / useT / useLang / interpolate /
 * SUPPORTED_LOCALES / LocaleCode / _testInternals) は移行前と byte 互換に保つ (= 各 page の
 * import は不変)。
 *
 * admin-console だけ interpolate が **fail-closed** (未供給 placeholder → 空文字。 raw `{name}` を
 * UI に漏らさない #655)。 他 2 SPA の keep-placeholder と方針が逆なので、 web-kit factory の
 * `interpolate` override で注入する (= core は共有しつつ補間ポリシーだけ差し替える)。
 */

import { createI18n } from "@tenkacloud/web-kit";
import en from "./locales/en.json";
import ja from "./locales/ja.json";

export const SUPPORTED_LOCALES = ["ja", "en"] as const;
export type LocaleCode = (typeof SUPPORTED_LOCALES)[number];

/**
 * 翻訳テンプレートに `{name}` 形式の placeholder を埋め込む helper。
 *
 * 単純な `template.replace("{x}", vars.x).replace("{y}", vars.y)` だと `vars.x = "{y}"` のような
 * 病的 input で意図しない 2 重置換が起きる。 1 pass の regex replacement で safety を担保する
 * (= 各 placeholder は元 template 上の 1 度しか展開されない)。
 *
 * 未定義 key は空文字列に置換 (= raw `{name}` を UI に漏らさない fail-closed)。
 *
 * 使用例: `interpolate(t("modal.body"), { tenantName: "Acme", tenantId: "abc" })`
 */
export function interpolate(template: string, vars: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => (key in vars ? vars[key] : ""));
}

const kit = createI18n<LocaleCode>({
  dictionaries: { ja, en },
  supportedLocales: SUPPORTED_LOCALES,
  defaultLocale: "ja",
  fallbackLocale: "en",
  storageKey: "tenkacloud.admin.locale",
  // fail-closed policy を t() にも適用する (params 未指定なら template をそのまま返す)。
  interpolate: (template, params) => {
    if (!params) return template;
    const stringified: Record<string, string> = {};
    for (const k of Object.keys(params)) stringified[k] = String(params[k]);
    return interpolate(template, stringified);
  },
});

export const I18nProvider = kit.I18nProvider;
export const useI18n = kit.useI18n;
export const useT = kit.useT;
export const useLang = kit.useLang;

/** Tests / debug 用に dictionaries を露出。 console 本体からは使わない。 */
export const _testInternals = {
  LOCALE_DICTIONARIES: kit.internals.dictionaries,
  resolveKey: kit.internals.resolveKey,
  detectBrowserLocale: kit.internals.detectBrowserLocale,
};
