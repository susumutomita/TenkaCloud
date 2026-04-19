/**
 * Deployment Status Hook
 *
 * 参加者のデプロイメント状態を取得するカスタムフック。
 * 攻撃/防御/投票ページで、環境がデプロイされていない場合に
 * fail-closed エラーを表示するために使用する。
 */

'use client';

import { useEffect, useState } from 'react';
import { getEventDeploymentStatus } from '@/lib/api/gameday';
import type { DeploymentStatus } from '@/lib/api/gameday-types';

interface UseDeploymentStatusResult {
  /** デプロイが完了しているか */
  isReady: boolean;
  /** チェック中か */
  isChecking: boolean;
  /** デプロイメント状態の詳細 */
  status: DeploymentStatus | null;
  /** 取得エラー（ネットワークエラー等） */
  checkError: Error | null;
}

/**
 * イベントのデプロイメント状態を取得するフック
 *
 * @param eventId イベント ID
 */
export function useDeploymentStatus(
  eventId: string | undefined,
): UseDeploymentStatusResult {
  const [isReady, setIsReady] = useState(false);
  const [isChecking, setIsChecking] = useState(true);
  const [status, setStatus] = useState<DeploymentStatus | null>(null);
  const [checkError, setCheckError] = useState<Error | null>(null);

  useEffect(() => {
    if (!eventId) {
      setIsChecking(false);
      return;
    }

    let cancelled = false;

    async function check() {
      try {
        const result = await getEventDeploymentStatus(eventId!);
        if (cancelled) return;
        setStatus(result);
        setIsReady(result.deployed);
        setCheckError(null);
      } catch (err) {
        if (cancelled) return;
        setCheckError(
          err instanceof Error ? err : new Error('Failed to check deployment'),
        );
        // エラー時は fail-closed: デプロイチェックが失敗した場合は安全側に倒す
        setIsReady(false);
      } finally {
        if (!cancelled) setIsChecking(false);
      }
    }

    check();

    return () => {
      cancelled = true;
    };
  }, [eventId]);

  return { isReady, isChecking, status, checkError };
}
