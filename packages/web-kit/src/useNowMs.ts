import { useCallback, useState } from "react";
import { usePolling } from "./usePolling";

/**
 * 現在時刻 (epoch ms) を `intervalMs` ごとに更新して返す clock hook (3 SPA 共通)。
 *
 * countdown / 残時間 / 相対時刻のような「時計を一定間隔で再評価して再描画したい」 UI の
 * re-render driver。 fetch せず client-side のみで動く (= leaderboard 等の data polling とは別系統)。
 * participant-portal の CountdownTimer / CliCredentialsPanel / ProblemPanel に
 * `useState(Date.now) + setInterval(setNow(Date.now())) + clearInterval` が copy-paste されていたのを
 * 1 箇所へ集約する (DRY / 単一責務)。
 *
 * {@link usePolling} の上に薄く乗る: 初期値は mount 時刻 (`useState` initializer)、 以後は
 * `immediate: false` で「次の周期から」 interval 更新する (= mount 直後に冗長な setState を打たない)。
 * tick callback は `useCallback([])` で安定化し、 nowMs 更新由来の再描画で interval を張り直さない。
 *
 * @param intervalMs 時計を再評価する間隔 (ms)。
 * @returns 直近の `Date.now()` (epoch ms)。
 */
export function useNowMs(intervalMs: number): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const tick = useCallback(() => setNowMs(Date.now()), []);
  usePolling(tick, intervalMs, { immediate: false });
  return nowMs;
}
