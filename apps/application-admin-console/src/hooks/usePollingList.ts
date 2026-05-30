import { useCallback, useEffect, useState } from "react";
import { toErrorMessage } from "../lib/error-message";

export interface PollingListState<T> {
  /** 取得済の一覧。 初回 fetch 前 / fetcher 不在は null (= loading 判定に使う)。 */
  readonly items: readonly T[] | null;
  /** 直近 fetch のエラー文字列。 成功で null にリセット。 */
  readonly error: string | null;
  /** 手動再取得 (reload button 等)。 polling と同じ経路を 1 回実行する。 */
  readonly refresh: () => Promise<void>;
}

/**
 * 一覧を一定間隔で polling する共有 hook。
 *
 * Deployments / ProblemDetail の deployment 一覧で
 * 「初回 fetch + setInterval polling + unmount 時の cancelled guard + error 文字列化 +
 * 等価なら reference 据え置き」 が完全に copy-paste されていたのを 1 箇所へ集約する
 * (DRY / 単一責務)。
 *
 * @param fetcher 一覧取得関数。 apiClient 不在などで取得できないときは null を渡す
 *               (= fetch せず items=null のまま loading を維持)。
 * @param intervalMs polling 間隔 (ms)。
 * @param hasChanged 任意。 前回結果から変化が無ければ (= false) setItems を skip して同一
 *             reference を保つ (Cloudscape Table の無駄な reconcile を防ぐ)。 省略時は毎回置換。
 */
export function usePollingList<T>(
  fetcher: (() => Promise<readonly T[]>) | null,
  intervalMs: number,
  hasChanged?: (prev: readonly T[], next: readonly T[]) => boolean,
): PollingListState<T> {
  const [items, setItems] = useState<readonly T[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!fetcher) return;
    try {
      const next = await fetcher();
      setItems((prev) => (prev && hasChanged && !hasChanged(prev, next) ? prev : next));
      setError(null);
    } catch (err) {
      setError(toErrorMessage(err));
    }
  }, [fetcher, hasChanged]);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      // unmount 時に clearInterval するので interval 経由の再 tick は来ない。 cancelled=true を
      // 踏むのは teardown と既 queue の tick が競合する稀ケースのみ (= 防御的、不到達)。
      /* v8 ignore next */
      if (cancelled) return;
      await refresh();
    };
    void tick();
    const interval = setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [refresh, intervalMs]);

  return { items, error, refresh };
}
