import { toErrorMessage, usePolling } from "@tenkacloud/web-kit";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getScoreEvents, PortalAuthError, type ScoreEventsResponse } from "../api/portal-client";
import { useAuth } from "../auth/AuthProvider";
import { DEV_MOCK_SCORE_EVENTS } from "../auth/dev-mock-fixtures";
import type { AppConfig } from "../config";
import { useIsMock } from "../config-context";
import { POLL_INTERVAL_MS } from "../constants/polling";
import { buildCumulativeSeries, type ChartPoint, chartXDomain } from "../lib/score-events-chart";

/** {@link useScoreEventsData} の戻り値。 ScoreEventsPage が render に必要とする state + 操作。 */
export interface ScoreEventsData {
  /** 取得済みの score-event 応答。 未取得なら null (= loading 判定に使う)。 */
  readonly data: ScoreEventsResponse | null;
  /** 累積スコア折れ線の data point 列 (= data から導出)。 未取得時は空配列。 */
  readonly series: readonly ChartPoint[];
  /** 折れ線の x 軸 domain。 series が空なら undefined。 */
  readonly xDomain: [Date, Date] | undefined;
  /** fetch 失敗時のメッセージ。 PortalAuthError は logout に振り替えるので含まない。 */
  readonly error: string | null;
  /** auto refresh (30s polling) の有効/無効。 */
  readonly autoRefresh: boolean;
  /** auto refresh トグルの setter。 */
  readonly setAutoRefresh: (next: boolean) => void;
  /** 「最新を取得」 ボタンの loading 表示用 (= tick 実行中)。 */
  readonly isRefreshing: boolean;
  /** session 確立済みかつ非 mock のとき true (= refresh コントロールを出すか)。 */
  readonly canRefresh: boolean;
  /** 即時 1 回 fetch を走らせる (= 手動 refresh)。 */
  readonly refresh: () => void;
}

/**
 * score-event の取得・auto refresh・error / dev-mock seed を一手に引き受ける hook。
 *
 * ScoreEventsPage から抽出し (SRP)、 ページ側は描画だけに専念できるようにした。 挙動は旧
 * ページと同一:
 *
 *  - 初回 fetch は mount 後 1 回だけ (DynamoDB read 抑制のため 30s polling は opt-in)。
 *  - auto refresh は web-kit の usePolling に集約 (#1418 DRY)、 immediate:false で初回は
 *    上の effect が担い、 enabled gate が autoRefresh + 非 mock + session を制御する。
 *  - PortalAuthError は logout、 それ以外の error は文字列化して返す (no-silent-fallback)。
 *  - dev-mock mode では backend を叩かず fixture を 1 度だけ seed する (LP「モックで試す」 動線)。
 *  - in-flight 中の重複 tick は同じ Promise を共有して DynamoDB read を増やさない。
 */
export function useScoreEventsData(config: AppConfig): ScoreEventsData {
  const auth = useAuth();
  const isMock = useIsMock();
  const sessionToken = auth.session?.sessionToken ?? null;

  const [data, setData] = useState<ScoreEventsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const refreshInFlightRef = useRef<Promise<void> | null>(null);

  const tick = useCallback(async () => {
    // 呼び出し元の useEffect / usePolling が同条件を gate 済み。 ここは getScoreEvents に渡す
    // sessionToken を string へ narrow するための型ガードで、 true 分岐は不到達。
    /* v8 ignore next */
    if (isMock || !sessionToken) return;
    if (refreshInFlightRef.current) return refreshInFlightRef.current;
    const run = (async () => {
      setIsRefreshing(true);
      try {
        const next = await getScoreEvents(config.apiBaseUrl, sessionToken);
        setData(next);
        setError(null);
      } catch (err) {
        if (err instanceof PortalAuthError) {
          auth.logout();
          return;
        }
        setError(toErrorMessage(err));
      } finally {
        refreshInFlightRef.current = null;
        setIsRefreshing(false);
      }
    })();
    refreshInFlightRef.current = run;
    return run;
  }, [isMock, sessionToken, config.apiBaseUrl, auth]);

  // 初回 fetch は 1 回だけ。30s polling は DynamoDB read 抑制のため opt-in。
  useEffect(() => {
    if (isMock || !sessionToken) return;
    void tick();
  }, [isMock, sessionToken, tick]);

  // auto refresh は web-kit の usePolling に集約 (#1418 DRY)。 初回 fetch は上の effect が担うので
  // immediate:false。 enabled gate が autoRefresh + mock/session 条件を制御する。
  usePolling(tick, POLL_INTERVAL_MS, {
    immediate: false,
    enabled: autoRefresh && !isMock && Boolean(sessionToken),
  });

  // LP 「モックで試す」 動線: dev-mock mode では backend を叩かないので、 fixture を
  // 1 度だけ seed する (= 競技中のスコア推移 chart + 履歴 table をデモで見せる)。
  useEffect(() => {
    if (!isMock) return;
    if (!sessionToken) return;
    if (data) return;
    setData(DEV_MOCK_SCORE_EVENTS);
  }, [isMock, sessionToken, data]);

  const refresh = useCallback(() => void tick(), [tick]);

  const series = useMemo(() => (data ? buildCumulativeSeries(data.entries) : []), [data]);
  const xDomain = useMemo(() => chartXDomain(series), [series]);

  return {
    data,
    series,
    xDomain,
    error,
    autoRefresh,
    setAutoRefresh,
    isRefreshing,
    canRefresh: !isMock && Boolean(sessionToken),
    refresh,
  };
}
