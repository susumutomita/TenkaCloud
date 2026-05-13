/**
 * Issue #583 i18n Phase 1.A: participant-portal の i18n 基盤。
 *
 * 設計判断:
 *   - **homegrown 実装** (= react-i18next 等の lib 非導入)。 4 言語 × ~30 keys 規模なら自前で
 *     済む + supply-chain audit-baseline 更新が不要 + bundle size 増えない (= 50KB 削減)。
 *     Phase 1.B で 3 SPA 全部に展開する時にライブラリ採択を再評価する。
 *   - **navigator.language → localStorage** の 2 段検出: 起動時 navigator.language で auto-detect、
 *     UI で切り替えたら localStorage に永続化、 次回起動はそれが優先。
 *   - **fallback chain**: 指定 locale で key 不在 → en → key 文字列そのまま。 missing key を
 *     見つけやすくする (= 「app.title」 のような raw key が出たら抽出忘れ)。
 *   - **react context + hook**: Provider が現在 locale + setLocale を提供、 useT() hook で
 *     翻訳関数を取り出す。 子 component は import なしで利用可。
 */

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import en from "./locales/en.json";
import es from "./locales/es.json";
import ja from "./locales/ja.json";
import zh from "./locales/zh.json";

export const SUPPORTED_LOCALES = ["ja", "en", "es", "zh"] as const;
export type LocaleCode = (typeof SUPPORTED_LOCALES)[number];

const LOCALE_DICTIONARIES: Record<LocaleCode, Record<string, unknown>> = {
  ja,
  en,
  es,
  zh,
};

const LOCAL_STORAGE_KEY = "tenkacloud.admin.locale";

/**
 * `navigator.language` (= "en-US" / "ja-JP" 等) を SUPPORTED_LOCALES のいずれかに narrow。
 * 一致なければ "ja" を default にする (= 既存 UI を維持)。
 */
function detectBrowserLocale(): LocaleCode {
  if (typeof navigator === "undefined") return "ja";
  const raw = (navigator.language || "ja").toLowerCase();
  for (const code of SUPPORTED_LOCALES) {
    if (raw.startsWith(code)) return code;
  }
  return "ja";
}

function loadStoredLocale(): LocaleCode | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const stored = window.localStorage.getItem(LOCAL_STORAGE_KEY);
    if (stored && (SUPPORTED_LOCALES as readonly string[]).includes(stored)) {
      return stored as LocaleCode;
    }
  } catch {
    // localStorage access denied (= incognito strict mode 等) → default fallback
  }
  return undefined;
}

function persistLocale(code: LocaleCode): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LOCAL_STORAGE_KEY, code);
  } catch {
    // ignore
  }
}

/**
 * dot-separated key (e.g. "app.title") を nested object から取り出す。 未定義は undefined。
 */
function resolveKey(dict: Record<string, unknown>, key: string): string | undefined {
  const parts = key.split(".");
  let node: unknown = dict;
  for (const p of parts) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[p];
  }
  return typeof node === "string" ? node : undefined;
}

interface I18nContextValue {
  readonly locale: LocaleCode;
  readonly setLocale: (code: LocaleCode) => void;
  readonly t: (key: string) => string;
}

const I18nContext = createContext<I18nContextValue | undefined>(undefined);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<LocaleCode>(
    () => loadStoredLocale() ?? detectBrowserLocale(),
  );

  // <html lang="..."> も locale に追従させる (= a11y / screen reader 対応)。
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((code: LocaleCode) => {
    setLocaleState(code);
    persistLocale(code);
  }, []);

  const t = useCallback(
    (key: string): string => {
      // 1) 指定 locale で lookup → 2) en で fallback → 3) raw key
      const v = resolveKey(LOCALE_DICTIONARIES[locale], key);
      if (v !== undefined) return v;
      const fallback = resolveKey(LOCALE_DICTIONARIES.en, key);
      return fallback ?? key;
    },
    [locale],
  );

  const value = useMemo<I18nContextValue>(() => ({ locale, setLocale, t }), [locale, setLocale, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be called inside <I18nProvider>");
  return ctx;
}

/** 翻訳関数だけが必要な hot path 用 shortcut。 */
export function useT(): (key: string) => string {
  return useI18n().t;
}

/** Tests / debug 用に dictionaries を露出。 portal 本体からは使わない。 */
export const _testInternals = { LOCALE_DICTIONARIES, resolveKey, detectBrowserLocale };
