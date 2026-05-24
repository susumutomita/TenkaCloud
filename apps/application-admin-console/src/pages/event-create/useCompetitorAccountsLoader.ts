/**
 * Phase 2.2 (Issue #459) / #671: EventCreate ページの Competitor Accounts
 * fetch + window focus 時の自動再取得を hook に切り出したもの。
 *
 * EventCreate.tsx の責務分割 (Issue #1241) の一部。 fetch logic と state を
 * 1 か所に閉じ込めることで、 parent ページは「いつ Alert を出すか」 だけに集中できる。
 */
import { useCallback, useEffect, useState } from "react";
import { type ApiClient, useApiClient } from "../../api/client";
import {
  type CompetitorAccountSummary,
  listCompetitorAccounts,
} from "../../api/competitor-accounts-client";
import type { AppConfig } from "../../config";
import { formatCompetitorAccountsLoadError } from "../../lib/competitor-accounts-filter";

export interface CompetitorAccountsLoaderState {
  /** 取得済 (= null → 未取得 / [] → 取得済で 0 件) */
  competitorAccounts: readonly CompetitorAccountSummary[] | null;
  accountsLoadError: string | null;
  accountsLoading: boolean;
  /** Alert の reload button から手動再取得するための bound fn。 */
  fetchAccounts: () => Promise<void>;
}

export function useCompetitorAccountsLoader(config: AppConfig): CompetitorAccountsLoaderState {
  const apiClient = useApiClient(config);
  const [competitorAccounts, setCompetitorAccounts] = useState<
    readonly CompetitorAccountSummary[] | null
  >(null);
  const [accountsLoadError, setAccountsLoadError] = useState<string | null>(null);
  const [accountsLoading, setAccountsLoading] = useState(false);

  const fetchAccounts = useCallback(async () => {
    if (!apiClient) return;
    setAccountsLoading(true);
    setAccountsLoadError(null);
    try {
      const res = await listCompetitorAccounts(apiClient as ApiClient);
      setCompetitorAccounts(res.items);
    } catch (err) {
      // Issue #815: 401 は friendly な「再ログインしてください」 に flip。 silent 空配列で
      // operator が次の一手を見失う UX を防ぐ (= 旧 unknown-tenant fallback の置き換え)。
      setAccountsLoadError(formatCompetitorAccountsLoadError(err));
    } finally {
      setAccountsLoading(false);
    }
  }, [apiClient]);

  useEffect(() => {
    void fetchAccounts();
  }, [fetchAccounts]);

  // #671: window focus 時に再取得する。 別タブで Verify した直後に戻ったとき、
  // dropdown が古い空配列のまま動かない問題への対処。
  useEffect(() => {
    const onFocus = () => {
      void fetchAccounts();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [fetchAccounts]);

  return { competitorAccounts, accountsLoadError, accountsLoading, fetchAccounts };
}
