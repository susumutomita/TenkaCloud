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
  reload: () => Promise<void>;
  verify: (awsAccountId: string) => Promise<void>;
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
    reload,
    verify,
    remove,
  };
}
