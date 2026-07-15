import { toErrorMessage, usePolling } from "@tenkacloud/web-kit";
import { StatusCodes } from "http-status-codes";
import { useCallback, useEffect, useState } from "react";
import { type CapacityOverview, getCapacityOverview } from "../api/capacity-client";
import { type ApiClient, ApiError } from "../api/client";
import { DEPLOYMENT_POLL_INTERVAL_MS } from "../constants/polling";

/**
 * Issue #2410 Slice 2: `GET /admin/capacity` の 30 秒 polling state hook。
 * (fetch + polling + error 文字列化 + unmount ガードのセットを component から分離する —
 * `usePollingList` と同じ動機の単一 object 版。)
 *
 * polling を止める 2 条件 (無駄な有料 GetMetricData / Lambda invoke を出さない):
 *  - terminal エラー: 403 (TenantAdmin 以外) / 503 (env 未配線の旧 deploy) / 501 (demo mode) は
 *    再 poll しても結果が変わらないので polling を停止し、理由を {@link terminalReason} で返す。
 *    手動 refresh は常に可能で、成功すれば polling が再開する。
 *  - ページ非表示: ブラウザが hidden の間は poll しない (再表示で即 fetch)。
 */

export type CapacityTerminalReason = "forbidden" | "unavailable" | "unsupported" | "not_applicable";

export interface CapacityOverviewState {
  readonly overview: CapacityOverview | null;
  readonly error: string | null;
  readonly terminalReason: CapacityTerminalReason | null;
  /** 手動再取得。polling 停止中 (terminal / hidden) でも実行できる。 */
  readonly refresh: () => Promise<void>;
}

function terminalReasonOf(err: unknown): CapacityTerminalReason | null {
  if (!(err instanceof ApiError)) return null;
  if (err.status === StatusCodes.FORBIDDEN) return "forbidden";
  if (err.status === StatusCodes.SERVICE_UNAVAILABLE) return "unavailable";
  // demo mode: fixture client は /admin/capacity を simulate しない (EventProgressionGatePanel
  // の isDemoFlagsUnsupported と同じ NOT_IMPLEMENTED 慣行)。
  if (err.status === StatusCodes.NOT_IMPLEMENTED) return "unsupported";
  // Issue #2648: 純 SQL backend は DynamoDB を使わないので容量監視は非該当 (route が 404 を返す)。
  // panel 自体を出さない terminal 状態 (CapacityPanel が null を描く)。
  if (err.status === StatusCodes.NOT_FOUND) return "not_applicable";
  return null;
}

/** `document.visibilityState` を購読する。hidden の間 polling を止めるための最小 hook。 */
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return visible;
}

export function useCapacityOverview(apiClient: ApiClient | null): CapacityOverviewState {
  const [overview, setOverview] = useState<CapacityOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [terminalReason, setTerminalReason] = useState<CapacityTerminalReason | null>(null);
  const pageVisible = usePageVisible();

  const refresh = useCallback(
    async (isActive?: () => boolean) => {
      if (!apiClient) return;
      try {
        const next = await getCapacityOverview(apiClient);
        // usePolling の isActive: unmount / re-arm 後に stale response で setState しない。
        if (isActive && !isActive()) return;
        setOverview(next);
        setError(null);
        setTerminalReason(null);
      } catch (err) {
        if (isActive && !isActive()) return;
        setTerminalReason(terminalReasonOf(err));
        setError(toErrorMessage(err));
      }
    },
    [apiClient],
  );

  usePolling(refresh, DEPLOYMENT_POLL_INTERVAL_MS, {
    enabled: pageVisible && terminalReason === null,
  });

  return { overview, error, terminalReason, refresh };
}
