import { toErrorMessage, usePolling } from "@tenkacloud/web-kit";
import { StatusCodes } from "http-status-codes";
import { useCallback, useMemo, useState } from "react";
import {
  AdminInsightApiError,
  fetchStateMachineExecutions,
  type StateMachineExecutionItem,
} from "../api/admin-drill-down";
import { useAuth } from "../auth/AuthProvider";
import type { AppConfig } from "../config";
import { JOBS_PAGE_SIZE } from "../constants/pagination";
import { ADMIN_POLL_INTERVAL_MS } from "../constants/polling";

/**
 * Issue #814 Phase 2: Deprovisioning Jobs (= SBT BashJobRunner の `deprovisioningJobRunner` が動かす
 * Step Functions State Machine の execution 履歴) を 60s polling で取得する hook。
 *
 * `DeprovisioningJobsTab` から SRP 分離 (#refactor)。 503 (= not_configured、 旧 stack 互換) は
 * `notConfigured` を立て、 呼び出し側が legacy placeholder + SFN console link にフォールバックする。
 */
export interface DeprovisioningJobsState {
  /** 取得済み execution。 未取得 (= loading) のときは null。 */
  readonly items: readonly StateMachineExecutionItem[] | null;
  /** 非 403 失敗時の表示用メッセージ。 */
  readonly error: string | null;
  /** 403 = admin insight API へのアクセス権が無い。 */
  readonly forbidden: boolean;
  /** API が null (= 503、 deprovisioning SM 未設定) を返した。 */
  readonly notConfigured: boolean;
  /** not_configured フォールバックで開く SFN state machines 一覧の AWS console URL。 */
  readonly sfnListUrl: string;
}

export function useDeprovisioningJobs(config: AppConfig): DeprovisioningJobsState {
  const auth = useAuth();
  const [items, setItems] = useState<readonly StateMachineExecutionItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [notConfigured, setNotConfigured] = useState(false);

  const idToken = auth.tokens?.idToken;
  const region = config.awsRegion || "ap-northeast-1";

  const fetchOnce = useCallback(async () => {
    // defensive guard: 下の usePolling が `enabled: Boolean(idToken)` で gate するため fetchOnce は
    // token 有り時しか呼ばれない (= この early return は不到達)。
    /* v8 ignore next */
    if (!idToken) return;
    try {
      const res = await fetchStateMachineExecutions(config, idToken, { limit: JOBS_PAGE_SIZE });
      if (res === null) {
        setNotConfigured(true);
        setItems([]);
        return;
      }
      setItems(res.items);
      setError(null);
      setForbidden(false);
      setNotConfigured(false);
    } catch (err) {
      if (err instanceof AdminInsightApiError && err.status === StatusCodes.FORBIDDEN) {
        setForbidden(true);
        return;
      }
      setError(toErrorMessage(err));
    }
  }, [config, idToken]);

  // 初回 fetch + 60s polling + unmount cleanup は usePolling (web-kit) に集約 (#1418 DRY)。
  // idToken 解決前は enabled=false で timer を張らない (既存の effect gate を踏襲)。
  usePolling(fetchOnce, ADMIN_POLL_INTERVAL_MS, { enabled: Boolean(idToken) });

  const sfnListUrl = useMemo(
    () => `https://${region}.console.aws.amazon.com/states/home?region=${region}#/statemachines`,
    [region],
  );

  return { items, error, forbidden, notConfigured, sfnListUrl };
}
