import { createContext, type ReactNode, useContext, useMemo } from "react";
import type { AppConfig } from "./config";

/**
 * `AppConfig` は `loadConfig()` で起動時に解決し、 main.tsx で `<AppConfigProvider>` に
 * 渡す。 page / component は `useAppConfig()` で参照する。
 *
 * **Why a context (= prop drill 廃止)**:
 *   旧: page → ProblemPanel → FlagSubmissionPanel と 3 段で `isMock={config.mode !==
 *       "backend"}` を渡していた (= Thermo-Nuclear review P1 指摘の thin wrapper)。
 *   新: 中間 component は config を知らない。 葉 component が必要なら useAppConfig で
 *       直接読む。 derived `isMock` も `useIsMock()` helper として提供。
 *
 * Mock / backend の簡易判定は `useIsMock()` に集約する。
 */

const AppConfigContext = createContext<AppConfig | null>(null);

export function AppConfigProvider({
  config,
  children,
}: {
  readonly config: AppConfig;
  readonly children: ReactNode;
}) {
  // Object identity を react-friendly に固定 (= props.config が同じ参照なら再 render
  // 連鎖を抑える)。 loadConfig は起動時 1 回しか走らないので useMemo 不要だが、 念のため
  // wrap して context value の参照同一性を保証する。
  const value = useMemo(() => config, [config]);
  return <AppConfigContext.Provider value={value}>{children}</AppConfigContext.Provider>;
}

export function useAppConfig(): AppConfig {
  const ctx = useContext(AppConfigContext);
  if (!ctx) throw new Error("useAppConfig must be used inside <AppConfigProvider>");
  return ctx;
}

/**
 * `mode !== "backend"` を返す derived hook。 dev-mock / future な offline 系を 1 箇所で
 * 同義語化する (= 「backend 連携している」 の否定 = mock-mode と表現)。
 */
export function useIsMock(): boolean {
  return useAppConfig().mode !== "backend";
}
