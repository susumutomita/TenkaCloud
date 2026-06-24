import { toErrorMessage, usePolling } from "@tenkacloud/web-kit";
import { StatusCodes } from "http-status-codes";
import { useCallback, useState } from "react";
import {
  AdminInsightApiError,
  fetchPipelineExecutions,
  type PipelineExecutionItem,
} from "../api/admin-drill-down";
import { useAuth } from "../auth/AuthProvider";
import type { AppConfig } from "../config";
import { JOBS_PAGE_SIZE } from "../constants/pagination";
import { ADMIN_POLL_INTERVAL_MS } from "../constants/polling";

/**
 * Issue #658: Provisioning Jobs (= `tenkacloud-saas-pipeline` の execution 履歴) を
 * 60s polling で取得する hook。 `JobsPage` から SRP 分離 (#refactor) — fetch / polling /
 * 4 状態 (loading / not-configured / forbidden / error) の管理だけを担い、 描画は呼び出し側。
 */
export interface ProvisioningJobsState {
  /** 取得済み execution。 未取得 (= loading) のときは null。 */
  readonly items: readonly PipelineExecutionItem[] | null;
  /** 非 403 失敗時の表示用メッセージ。 dismiss で null へ戻せる。 */
  readonly error: string | null;
  /** 403 = admin insight API へのアクセス権が無い。 */
  readonly forbidden: boolean;
  /** API が null (= 旧 stack 互換、 pipeline 未設定) を返した。 */
  readonly notConfigured: boolean;
  /** error alert の dismiss ハンドラ。 */
  readonly dismissError: () => void;
}

export function useProvisioningJobs(config: AppConfig): ProvisioningJobsState {
  const auth = useAuth();
  const [items, setItems] = useState<readonly PipelineExecutionItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [notConfigured, setNotConfigured] = useState(false);

  const idToken = auth.tokens?.idToken;

  const fetchOnce = useCallback(async () => {
    if (!idToken) return;
    try {
      const res = await fetchPipelineExecutions(config, idToken, { limit: JOBS_PAGE_SIZE });
      if (res === null) {
        setNotConfigured(true);
        return;
      }
      setItems(res.items);
      setError(null);
      setForbidden(false);
    } catch (err) {
      if (err instanceof AdminInsightApiError && err.status === StatusCodes.FORBIDDEN) {
        setForbidden(true);
      } else {
        setError(toErrorMessage(err));
      }
    }
  }, [config, idToken]);

  // 初回 fetch + 60s polling + unmount cleanup は usePolling (web-kit) に集約 (#1418 DRY)。
  // idToken 不在は fetchOnce 側が弾く (= effect レベルの gate を持たない既存挙動)。
  usePolling(fetchOnce, ADMIN_POLL_INTERVAL_MS);

  const dismissError = useCallback(() => setError(null), []);

  return { items, error, forbidden, notConfigured, dismissError };
}
