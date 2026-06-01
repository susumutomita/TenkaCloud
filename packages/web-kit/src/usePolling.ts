import { useEffect } from "react";

/** {@link usePolling} の任意設定。 */
export interface UsePollingOptions {
  /**
   * mount 直後に 1 回 callback を即実行するか。 false なら最初の tick は `intervalMs` 経過後
   * (= 一覧 fetch は即時が欲しいので既定 true、 時計の再評価のような「次の周期で十分」な用途は false)。
   */
  readonly immediate?: boolean;
  /**
   * false の間は interval を張らず polling を止める (= 条件が揃うまで待つ)。 false→true で polling 開始、
   * true→false で停止 + cleanup。 認証 token / 依存 state が未解決の間 fetch を skip する用途 (既定 true)。
   */
  readonly enabled?: boolean;
}

/**
 * 一定間隔で callback を呼ぶ共有 polling primitive (3 SPA 共通、 #1418)。
 *
 * `setInterval` + mount 時の即時実行 + unmount 時の `clearInterval` + 「unmount 後に解決した非同期
 * tick が state を触らないための active guard」 という boilerplate が admin-console の
 * TenantList / TenantDetail / Jobs に copy-paste されていたのを 1 箇所へ集約する (DRY / 単一責務)。
 * 意味論 (何を fetch し state をどう更新するか) は callback 側に残り、 本 hook は timer 制御だけを担う。
 *
 * SSE/WebSocket を使わず polling に寄せる方針 (AGENTS.md) と整合。 純粋に timer を扱うだけで
 * AWS SDK / fetch には依存しない (= portal-plugin-sdk と同様、 web-kit primitive の責務範囲)。
 *
 * @param callback 毎 tick 実行する処理。 引数 `isActive()` は hook が現在も mount 中かを返す
 *                 (= 非同期処理の解決後に `if (!isActive()) return;` で stale な setState を防ぐ)。
 * @param intervalMs polling 間隔 (ms)。
 * @param options {@link UsePollingOptions}。 省略時は即時実行あり / 有効。
 */
export function usePolling(
  callback: (isActive: () => boolean) => void | Promise<void>,
  intervalMs: number,
  options?: UsePollingOptions,
): void {
  const { immediate = true, enabled = true } = options ?? {};
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const isActive = () => active;
    const run = () => {
      void callback(isActive);
    };
    if (immediate) run();
    const handle = window.setInterval(run, intervalMs);
    return () => {
      active = false;
      window.clearInterval(handle);
    };
  }, [callback, intervalMs, immediate, enabled]);
}
