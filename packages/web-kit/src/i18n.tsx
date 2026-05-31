/**
 * Issue #1418 (web-kit Stage 2): 3 SPA に copy-paste されていた homegrown i18n core を
 * config 注入の factory に集約する。
 *
 * 各 SPA は locale dictionary / storage key / supported locales が違うだけで、 detect →
 * localStorage 永続化 → nested-key lookup → en fallback → interpolate という core は同型
 * (admin / application-admin / participant で drift していた interpolate signature は、
 * 最も一般的な `Record<string, string | number>` (= 他 2 つの superset) に統一する。 net 挙動は
 * 3 SPA 共通: lookup → fallback → raw key → 1-pass regex interpolate)。
 *
 * `createI18n(config)` は Context + Provider + hooks を 1 組だけ閉じ込めて返すので、 SPA 側は
 * 自分の dict / key を渡して thin に wrap するだけでよい (component の import は不変)。
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

/**
 * 翻訳テンプレートに `{name}` placeholder を 1-pass の regex で埋め込む。 `vars.x = "{y}"` のような
 * 病的 input でも各 placeholder は元 template 上 1 度しか展開されない (= 2 重置換を防ぐ)。
 */
export function interpolate(
  template: string,
  params?: Readonly<Record<string, string | number>>,
): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => {
    const v = params[name];
    return v === undefined ? match : String(v);
  });
}

/** dot-separated key (e.g. "app.title") を nested object から取り出す。 未定義 / 非文字列は undefined。 */
export function resolveKey(dict: Record<string, unknown>, key: string): string | undefined {
  const parts = key.split(".");
  let node: unknown = dict;
  for (const p of parts) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[p];
  }
  return typeof node === "string" ? node : undefined;
}

export interface I18nConfig<L extends string> {
  /** locale code → 翻訳 dictionary (nested object)。 */
  readonly dictionaries: Readonly<Record<L, Record<string, unknown>>>;
  /** 受理する locale code 一覧。 */
  readonly supportedLocales: readonly L[];
  /** navigator / 未対応時の default locale (= UI 初期表示)。 */
  readonly defaultLocale: L;
  /** key 不在時の fallback locale (= missing-key を埋める二段目)。 */
  readonly fallbackLocale: L;
  /** localStorage の永続化キー (SPA ごとに異なる)。 */
  readonly storageKey: string;
  /**
   * placeholder 補間関数の上書き (省略時は keep-placeholder の既定 {@link interpolate})。
   * admin-console のように fail-closed (= 未供給 placeholder を空文字に落とす) など、
   * SPA 固有の補間ポリシーを注入するための hook。 `t` と `internals.interpolate` の双方が
   * これを使う (= SPA 内で挙動が一貫する)。
   */
  readonly interpolate?: typeof interpolate;
}

export interface I18nContextValue<L extends string> {
  readonly locale: L;
  readonly setLocale: (code: L) => void;
  readonly t: (key: string, params?: Readonly<Record<string, string | number>>) => string;
}

export interface I18nKit<L extends string> {
  readonly I18nProvider: (props: { readonly children: ReactNode }) => ReactNode;
  readonly useI18n: () => I18nContextValue<L>;
  readonly useT: () => I18nContextValue<L>["t"];
  readonly useLang: () => L;
  /** tests / debug 用に内部 helper を露出 (config に bind 済)。 SPA 本体からは使わない。 */
  readonly internals: {
    readonly dictionaries: Readonly<Record<L, Record<string, unknown>>>;
    readonly resolveKey: typeof resolveKey;
    readonly interpolate: typeof interpolate;
    readonly detectBrowserLocale: () => L;
    readonly loadStoredLocale: () => L | undefined;
    readonly persistLocale: (code: L) => void;
  };
}

/** config を閉じ込めた i18n Context + hooks を 1 組生成する。 */
export function createI18n<L extends string>(config: I18nConfig<L>): I18nKit<L> {
  const { dictionaries, supportedLocales, defaultLocale, fallbackLocale, storageKey } = config;
  const interpolateFn = config.interpolate ?? interpolate;

  function detectBrowserLocale(): L {
    // SSR guard: navigator は browser / jsdom では常に定義済みなので不到達。
    /* v8 ignore next */
    if (typeof navigator === "undefined") return defaultLocale;
    const raw = (navigator.language || defaultLocale).toLowerCase();
    for (const code of supportedLocales) {
      if (raw.startsWith(code)) return code;
    }
    return defaultLocale;
  }

  function loadStoredLocale(): L | undefined {
    // SSR guard: window は browser / jsdom では常に定義済みなので不到達。
    /* v8 ignore next */
    if (typeof window === "undefined") return undefined;
    try {
      const stored = window.localStorage.getItem(storageKey);
      if (stored && (supportedLocales as readonly string[]).includes(stored)) {
        return stored as L;
      }
    } catch {
      // localStorage access denied (= incognito strict mode 等) → default fallback
    }
    return undefined;
  }

  function persistLocale(code: L): void {
    // SSR guard: 同上 (不到達)。
    /* v8 ignore next */
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(storageKey, code);
    } catch {
      // ignore
    }
  }

  const I18nContext = createContext<I18nContextValue<L> | undefined>(undefined);

  function I18nProvider({ children }: { readonly children: ReactNode }): ReactNode {
    const [locale, setLocaleState] = useState<L>(() => loadStoredLocale() ?? detectBrowserLocale());

    // <html lang="..."> も locale に追従させる (= a11y / screen reader 対応)。
    useEffect(() => {
      // SSR guard: document は browser / jsdom では常に定義済みなので不到達。
      /* v8 ignore next */
      if (typeof document === "undefined") return;
      document.documentElement.lang = locale;
    }, [locale]);

    const setLocale = useCallback((code: L) => {
      setLocaleState(code);
      persistLocale(code);
    }, []);

    const t = useCallback(
      (key: string, params?: Readonly<Record<string, string | number>>): string => {
        // 1) 指定 locale で lookup → 2) fallback locale → 3) raw key
        const v = resolveKey(dictionaries[locale], key);
        const template = v ?? resolveKey(dictionaries[fallbackLocale], key) ?? key;
        return interpolateFn(template, params);
      },
      [locale],
    );

    const value = useMemo<I18nContextValue<L>>(
      () => ({ locale, setLocale, t }),
      [locale, setLocale, t],
    );

    return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
  }

  function useI18n(): I18nContextValue<L> {
    const ctx = useContext(I18nContext);
    if (!ctx) throw new Error("useI18n must be called inside <I18nProvider>");
    return ctx;
  }

  return {
    I18nProvider,
    useI18n,
    useT: () => useI18n().t,
    useLang: () => useI18n().locale,
    internals: {
      dictionaries,
      resolveKey,
      interpolate: interpolateFn,
      detectBrowserLocale,
      loadStoredLocale,
      persistLocale,
    },
  };
}
