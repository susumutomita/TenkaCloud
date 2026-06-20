import { toErrorMessage, usePolling } from "@tenkacloud/web-kit";
import { StatusCodes } from "http-status-codes";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, useApiClient } from "../../api/client";
import {
  type DeploymentSummary,
  getDeployment,
  getStackProgress,
  JOB_ID_RE,
  type StackProgress,
  TERMINAL_STATUSES,
} from "../../api/deploy-client";
import type { AppConfig } from "../../config";
import { DEPLOYMENT_POLL_INTERVAL_MS } from "../../constants/polling";
import type { StackProgressErrorState } from "./types";

// deployment-cluster 共通の単一 source を再 export する (DeployLogSection が「次回更新まで N 秒」表示に使う)。
// Lambda invocation コスト抑制のため 30 秒 (= 旧 5 秒 polling は 12 req/min/user で過多)。
// deploy phase の進行は CloudFormation 側で数十秒〜数分単位なので、 30 秒粒度で十分。
export const POLL_INTERVAL_MS = DEPLOYMENT_POLL_INTERVAL_MS;

export type UseDeploymentDetailResult = {
  readonly item: DeploymentSummary | null;
  readonly error: string | null;
  readonly manualRefreshing: boolean;
  readonly stackProgress: StackProgress | null;
  readonly stackProgressError: StackProgressErrorState | null;
  readonly stackProgressPending: boolean;
  readonly reload: () => void;
};

/**
 * DeploymentDetail ページの data-fetching hook。基本情報と StackProgress を並列 polling し、
 * Terminal status (= COMPLETE / FAILED) に到達したら自動停止する。
 *
 * StackProgress の error は基本情報を巻き込まない (= 別 state に閉じる) ことで、 CFn API が
 * throttle / 権限不足で落ちても deployment summary は表示し続ける (#534)。
 */
export function useDeploymentDetail(
  config: AppConfig,
  jobId: string | undefined,
): UseDeploymentDetailResult {
  const apiClient = useApiClient(config);
  const [item, setItem] = useState<DeploymentSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const stopPollingRef = useRef(false);
  const [stackProgress, setStackProgress] = useState<StackProgress | null>(null);
  const [stackProgressError, setStackProgressError] = useState<StackProgressErrorState | null>(
    null,
  );
  const [stackProgressPending, setStackProgressPending] = useState(false);

  // showSpinner=true は手動再読み込みボタンからの呼び出し時のみ。auto polling は
  // 30 秒ごとに spinner を点滅させずバックグラウンド更新する。
  const fetchOnce = useCallback(
    async ({ showSpinner }: { showSpinner: boolean } = { showSpinner: false }) => {
      if (!apiClient || !jobId || !JOB_ID_RE.test(jobId)) return;
      if (showSpinner) setManualRefreshing(true);
      try {
        const fetched = await getDeployment(apiClient, jobId);
        setItem(fetched);
        setError(null);
        if (TERMINAL_STATUSES.has(fetched.status)) stopPollingRef.current = true;
      } catch (err) {
        setError(toErrorMessage(err));
      } finally {
        if (showSpinner) setManualRefreshing(false);
      }
    },
    [apiClient, jobId],
  );

  const fetchStackProgress = useCallback(async () => {
    if (!apiClient || !jobId || !JOB_ID_RE.test(jobId)) return;
    setStackProgressPending(true);
    try {
      const progress = await getStackProgress(apiClient, jobId);
      setStackProgress(progress);
      setStackProgressError(null);
    } catch (err) {
      // #687: 「stack 未割当」(= deploy 初期で CFn 未着手) は次のいずれかで判定:
      //   - 409 (= backend が `stack_not_yet_created` で返す正規 path)
      //   - 5xx (= upstream Lambda が cold / API GW route 未配線 等の transient 状態)
      //   - TypeError (= DNS / CORS preflight 失敗 = "Failed to fetch")
      // いずれも "準備中" graceful UI に集約し、 raw error は出さない (#656 と同 pattern)。
      const notYetCreated =
        (err instanceof ApiError &&
          (err.status === StatusCodes.CONFLICT ||
            err.status === StatusCodes.BAD_GATEWAY ||
            err.status === StatusCodes.SERVICE_UNAVAILABLE ||
            err.status === StatusCodes.GATEWAY_TIMEOUT)) ||
        err instanceof TypeError ||
        (err instanceof Error && /failed to fetch/i.test(err.message));
      const message = toErrorMessage(err);
      setStackProgressError({ message, notYetCreated });
    } finally {
      setStackProgressPending(false);
    }
  }, [apiClient, jobId]);

  const tick = useCallback(
    async (isActive: () => boolean) => {
      if (!isActive() || stopPollingRef.current) return;
      // 基本情報 + stack-progress を並列に fetch。stack-progress の error は基本情報を
      // 巻き込まない (= 別 state に閉じる)。Terminal 後も最終 stack 状態を 1 回 fetch するため
      // stopPollingRef は両 promise の after に評価する。
      await Promise.all([fetchOnce(), fetchStackProgress()]);
    },
    [fetchOnce, fetchStackProgress],
  );

  // polling を (再) 開始するたびに terminal 停止フラグをリセットする。tick の identity が変わる
  // (= jobId / apiClient 変更で別 deployment を見始める) とき再 enable したい。usePolling の即時
  // tick より前に走らせたいので usePolling より上に置く (effect は宣言順に setup される)。
  // biome-ignore lint/correctness/useExhaustiveDependencies: tick 変化での再 enable が目的 (body は tick を読まない)
  useEffect(() => {
    stopPollingRef.current = false;
  }, [tick]);

  // 即時 tick + interval polling + unmount cleanup (isActive guard) は web-kit の共有 primitive
  // に委譲する (#1418: polling timer の boilerplate を usePolling 1 箇所へ集約)。
  usePolling(tick, POLL_INTERVAL_MS);

  const reload = useCallback(() => {
    void fetchOnce({ showSpinner: true });
  }, [fetchOnce]);

  return {
    item,
    error,
    manualRefreshing,
    stackProgress,
    stackProgressError,
    stackProgressPending,
    reload,
  };
}
