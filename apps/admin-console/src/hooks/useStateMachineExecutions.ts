import { toErrorMessage, usePolling } from "@tenkacloud/web-kit";
import { StatusCodes } from "http-status-codes";
import { useCallback, useMemo, useState } from "react";
import { AdminInsightApiError, type StateMachineExecutionItem } from "../api/admin-drill-down";
import { useAuth } from "../auth/AuthProvider";
import type { AppConfig } from "../config";
import { JOBS_PAGE_SIZE } from "../constants/pagination";
import { ADMIN_POLL_INTERVAL_MS } from "../constants/polling";

/**
 * Step Functions の execution 履歴を 60s polling で取得する hook 本体。
 *
 * provisioning / deprovisioning は叩く route が違うだけで、 loading / 403 / 503 / エラーの扱いは
 * 同一。 hook を copy-paste すると片方だけ直してもう片方が古いまま残るので、 fetcher を差し替える
 * 形で 1 か所に集約する。
 *
 * 503 (= not_configured、 旧 stack 互換) は `notConfigured` を立て、 呼び出し側が SFN console link に
 * フォールバックする。
 */
export interface ExecutionsState<TItem> {
  /** 取得済み execution。 未取得 (= loading) のときは null。 */
  readonly items: readonly TItem[] | null;
  /** 非 403 失敗時の表示用メッセージ。 dismiss で null へ戻せる。 */
  readonly error: string | null;
  /** 403 = admin insight API へのアクセス権が無い。 */
  readonly forbidden: boolean;
  /** API が 503 / null (= 対象が未設定の旧 stack) を返した。 */
  readonly notConfigured: boolean;
  /** not_configured フォールバックで開く SFN state machines 一覧の AWS console URL。 */
  readonly sfnListUrl: string;
  /** error alert の dismiss ハンドラ。 */
  readonly dismissError: () => void;
}

export type StateMachineExecutionsState = ExecutionsState<StateMachineExecutionItem>;

export type ExecutionsFetcher<TItem> = (
  config: AppConfig,
  idToken: string,
  options: { limit?: number },
) => Promise<{ readonly items: readonly TItem[] } | null>;

export function useStateMachineExecutions<TItem>(
  config: AppConfig,
  fetchExecutions: ExecutionsFetcher<TItem>,
): ExecutionsState<TItem> {
  const auth = useAuth();
  const [items, setItems] = useState<readonly TItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [notConfigured, setNotConfigured] = useState(false);

  const idToken = auth.tokens?.idToken;
  const region = config.awsRegion || "ap-northeast-1";

  const fetchOnce = useCallback(async () => {
    // defensive guard: 下の usePolling が `enabled: Boolean(idToken)` で gate するため不到達。
    /* v8 ignore next */
    if (!idToken) return;
    try {
      const res = await fetchExecutions(config, idToken, { limit: JOBS_PAGE_SIZE });
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
  }, [config, idToken, fetchExecutions]);

  // 初回 fetch + 60s polling + unmount cleanup は usePolling (web-kit) に集約 (#1418 DRY)。
  usePolling(fetchOnce, ADMIN_POLL_INTERVAL_MS, { enabled: Boolean(idToken) });

  const sfnListUrl = useMemo(
    () => `https://${region}.console.aws.amazon.com/states/home?region=${region}#/statemachines`,
    [region],
  );
  const dismissError = useCallback(() => setError(null), []);

  return { items, error, forbidden, notConfigured, sfnListUrl, dismissError };
}
