import { toErrorMessage, usePolling } from "@tenkacloud/web-kit";
import { StatusCodes } from "http-status-codes";
import { useCallback, useMemo, useState } from "react";
import {
  AdminInsightApiError,
  fetchProvisioningExecutions,
  type StateMachineExecutionItem,
} from "../api/admin-drill-down";
import { useAuth } from "../auth/AuthProvider";
import type { AppConfig } from "../config";
import { JOBS_PAGE_SIZE } from "../constants/pagination";
import { ADMIN_POLL_INTERVAL_MS } from "../constants/polling";

/**
 * SBT ProvisioningScriptJob の Step Functions execution 履歴を 60s polling で取得する hook。
 *
 * テナントのプロビジョニングが実際に走るのはこの state machine で、 Provisioning Jobs 画面が長らく
 * 見ていた CodePipeline (`tenkacloud-saas-pipeline`) とは別経路だった。 そのため 3 テナントを
 * 同時に provisioning しても画面には 1 件も出ず、 代わりに無関係な pipeline の失敗だけが
 * 「プロビジョニング失敗」として表示されていた (2026-08-08 に運用者が誤認)。
 *
 * 形は `useDeprovisioningJobs` と対称。 503 (= not_configured、 旧 stack 互換) は `notConfigured`
 * を立て、 呼び出し側が SFN console link にフォールバックする。
 */
export interface ProvisioningExecutionsState {
  /** 取得済み execution。 未取得 (= loading) のときは null。 */
  readonly items: readonly StateMachineExecutionItem[] | null;
  /** 非 403 失敗時の表示用メッセージ。 */
  readonly error: string | null;
  /** 403 = admin insight API へのアクセス権が無い。 */
  readonly forbidden: boolean;
  /** API が 503 (= provisioning SM 未設定の旧 stack) を返した。 */
  readonly notConfigured: boolean;
  /** not_configured フォールバックで開く SFN state machines 一覧の AWS console URL。 */
  readonly sfnListUrl: string;
}

export function useProvisioningExecutions(config: AppConfig): ProvisioningExecutionsState {
  const auth = useAuth();
  const [items, setItems] = useState<readonly StateMachineExecutionItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [notConfigured, setNotConfigured] = useState(false);

  const idToken = auth.tokens?.idToken;
  const region = config.awsRegion || "ap-northeast-1";

  const fetchOnce = useCallback(async () => {
    // defensive guard: usePolling が `enabled: Boolean(idToken)` で gate するため不到達。
    /* v8 ignore next */
    if (!idToken) return;
    try {
      const res = await fetchProvisioningExecutions(config, idToken, { limit: JOBS_PAGE_SIZE });
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

  usePolling(fetchOnce, ADMIN_POLL_INTERVAL_MS, { enabled: Boolean(idToken) });

  const sfnListUrl = useMemo(
    () => `https://${region}.console.aws.amazon.com/states/home?region=${region}#/statemachines`,
    [region],
  );

  return { items, error, forbidden, notConfigured, sfnListUrl };
}
