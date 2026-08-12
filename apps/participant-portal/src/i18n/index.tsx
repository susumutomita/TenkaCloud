/**
 * Issue #583 i18n Phase 1.A / #1418 web-kit Stage 2: participant-portal の i18n。
 *
 * detect → localStorage 永続化 → nested-key lookup → en fallback → interpolate という core は
 * 3 SPA 共通だったため、 `@tenkacloud/web-kit` の `createI18n` factory に集約済み。ここは
 * 「locale dictionary (locales/*.json) + storage key を注入して factory を呼ぶ」 だけの thin shim で、
 * 公開 API (I18nProvider / useI18n / useT / useLang / SUPPORTED_LOCALES / LocaleCode / _testInternals)
 * は移行前と byte 互換に保つ (= 各 page の import は不変)。 挙動 (keep-placeholder interpolate /
 * ja default / en fallback) も移行前と同一。
 */

import { createI18n } from "@tenkacloud/web-kit";
import en from "./locales/en.json";
import ja from "./locales/ja.json";
import { resultCardLocaleMessages } from "./result-card-locales";

export const SUPPORTED_LOCALES = ["ja", "en"] as const;
export type LocaleCode = (typeof SUPPORTED_LOCALES)[number];

const dictionaries = {
  ja: { ...ja, result_card: resultCardLocaleMessages.ja },
  en: { ...en, result_card: resultCardLocaleMessages.en },
};

const kit = createI18n<LocaleCode>({
  dictionaries,
  supportedLocales: SUPPORTED_LOCALES,
  defaultLocale: "ja",
  fallbackLocale: "en",
  storageKey: "tenkacloud.portal.locale",
});

export const I18nProvider = kit.I18nProvider;
export const useI18n = kit.useI18n;
export const useT = kit.useT;
export const useLang = kit.useLang;

/** Tests / debug 用に dictionaries / 内部 helper を露出。 portal 本体からは使わない。 */
export const _testInternals = {
  LOCALE_DICTIONARIES: kit.internals.dictionaries,
  resolveKey: kit.internals.resolveKey,
  detectBrowserLocale: kit.internals.detectBrowserLocale,
  interpolate: kit.internals.interpolate,
  loadStoredLocale: kit.internals.loadStoredLocale,
  persistLocale: kit.internals.persistLocale,
};
