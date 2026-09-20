import { useCallback, useEffect, useState } from "react";
import { canMutateTenant, useApiClient } from "../../api/client";
import {
  type CompetitorAccountSummary,
  deleteCompetitorAccount,
  listCompetitorAccounts,
  verifyCompetitorAccount,
} from "../../api/competitor-accounts-client";
import type { AppConfig } from "../../config";
import { type FriendlyError, toFriendlyError } from "../../lib/friendly-error";

export interface UseCompetitorAccountsResult {
  items: readonly CompetitorAccountSummary[] | null;
  error: FriendlyError | null;
  verifyInFlight: string | null;
  deleteInFlight: boolean;
  canMutateTenant: boolean;
  /**
   * Issue #2696: 直近の verify が成功した account (= trust 検証が通った瞬間の signal)。
   * Lite mode のオンボーディングドリルのチェックポイント表示に使う。 dismiss / 再 verify
   * 失敗で null に戻る。
   */
  lastVerified: CompetitorAccountSummary | null;
  clearLastVerified: () => void;
  /**
   * 一括 verify の進捗 (`{done, total}`)。 実行中でなければ null。
   * 一括登録した直後は未検証行がまとめて並ぶので、 1 行ずつ押させない。
   */
  verifyAllProgress: { readonly done: number; readonly total: number } | null;
  reload: () => Promise<void>;
  verify: (awsAccountId: string) => Promise<void>;
  verifyAll: () => Promise<void>;
  remove: (awsAccountId: string) => Promise<void>;
}

export function useCompetitorAccounts(config: AppConfig): UseCompetitorAccountsResult {
  const apiClient = useApiClient(config);
  const canMutate = canMutateTenant(apiClient);
  const [items, setItems] = useState<readonly CompetitorAccountSummary[] | null>(null);
  const [error, setError] = useState<FriendlyError | null>(null);
  const [verifyInFlight, setVerifyInFlight] = useState<string | null>(null);
  const [deleteInFlight, setDeleteInFlight] = useState(false);
  const [lastVerified, setLastVerified] = useState<CompetitorAccountSummary | null>(null);
  const [verifyAllProgress, setVerifyAllProgress] = useState<{
    readonly done: number;
    readonly total: number;
  } | null>(null);

  const reload = useCallback(async () => {
    if (!apiClient) return;
    try {
      const res = await listCompetitorAccounts(apiClient);
      setItems(res.items);
      setError(null);
    } catch (err) {
      setError(toFriendlyError(err));
    }
  }, [apiClient]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const verify = useCallback(
    async (awsAccountId: string) => {
      if (!apiClient || !canMutate) return;
      setVerifyInFlight(awsAccountId);
      try {
        const res = await verifyCompetitorAccount(apiClient, awsAccountId);
        // Issue #2696: trust 検証が通ったときだけ signal を立てる (= verified=false の
        // 応答や例外では立てない)。 直近成功のみ保持し、 失敗は既存の error 表示に任せる。
        setLastVerified(res.verified ? res : null);
        await reload();
      } catch (err) {
        setLastVerified(null);
        setError(toFriendlyError(err));
      } finally {
        setVerifyInFlight(null);
      }
    },
    [apiClient, canMutate, reload],
  );

  const clearLastVerified = useCallback(() => setLastVerified(null), []);

  /**
   * 未検証の account をまとめて verify する。
   *
   * 専用の一括 endpoint は作らない。 verify は 1 件ごとに STS AssumeRole を 1 回投げる
   * 実 API 呼び出しで、 それを Lambda 側で N 件ぶん回すと実行時間が件数に比例して
   * 伸び、 途中で timeout したとき 「どこまで検証したか」 が応答に残らない。 既存の
   * 1 件用 endpoint を**逐次**呼ぶと、 進捗を画面に出せて、 途中で失敗しても残りが続く。
   *
   * 逐次なのは STS を同時に叩いて throttle させないため。 失敗した行は verified=false の
   * まま残るので、 個別の Verify button で追える。
   */
  const verifyAll = useCallback(async () => {
    if (!apiClient || !canMutate) return;
    const targets = (items ?? []).filter((item) => !item.verified);
    if (targets.length === 0) return;
    setVerifyAllProgress({ done: 0, total: targets.length });
    let lastError: unknown;
    let done = 0;
    for (const target of targets) {
      try {
        await verifyCompetitorAccount(apiClient, target.awsAccountId);
      } catch (err) {
        // 1 件の失敗で残りを止めない。 最後の理由だけ表示し、 詳細は行の状態が持つ。
        lastError = err;
      }
      done += 1;
      setVerifyAllProgress({ done, total: targets.length });
    }
    setVerifyAllProgress(null);
    // reload() は成功すると setError(null) するので、 失敗の表示は **その後** に置く。
    // 逆順だと 「1 行落ちたのに画面は何も言わない」 になる。
    await reload();
    if (lastError !== undefined) setError(toFriendlyError(lastError));
  }, [apiClient, canMutate, items, reload]);

  const remove = useCallback(
    async (awsAccountId: string) => {
      if (!apiClient || !canMutate) return;
      setDeleteInFlight(true);
      try {
        await deleteCompetitorAccount(apiClient, awsAccountId);
        await reload();
      } catch (err) {
        setError(toFriendlyError(err));
      } finally {
        setDeleteInFlight(false);
      }
    },
    [apiClient, canMutate, reload],
  );

  return {
    items,
    error,
    verifyInFlight,
    deleteInFlight,
    canMutateTenant: canMutate,
    lastVerified,
    clearLastVerified,
    verifyAllProgress,
    reload,
    verify,
    verifyAll,
    remove,
  };
}
