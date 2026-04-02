/**
 * Defense Trench (防衛塹壕)
 *
 * 受けている攻撃一覧、ヒント購入、脆弱性修正報告
 */

'use client';

import { useCallback, useEffect, useState } from 'react';
import { DefenseItem } from '@/components/gameday';
import { ErrorState, getErrorMessage, getErrorType } from '@/components/ui';
import { getActiveDefense, purchaseHint, reportFix } from '@/lib/api/gameday';
import type { AttackLog } from '@/lib/api/gameday-types';
import { useGamedaySession } from '@/lib/hooks/use-gameday-session';

export default function DefensePage() {
  const { eventId, teamId } = useGamedaySession();
  const [attacks, setAttacks] = useState<AttackLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [hints, setHints] = useState<Record<string, string>>({});
  const [hintLoading, setHintLoading] = useState<Record<string, boolean>>({});
  const [fixLoading, setFixLoading] = useState<Record<string, boolean>>({});

  const fetchData = useCallback(async () => {
    if (!eventId || !teamId) return;
    try {
      const data = await getActiveDefense(eventId, teamId);
      setAttacks(data.attacks);
      setError(null);
    } catch (err) {
      setError(
        err instanceof Error ? err : new Error('読み込みに失敗しました'),
      );
    } finally {
      setLoading(false);
    }
  }, [eventId, teamId]);

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, 10000);
    return () => clearInterval(id);
  }, [fetchData]);

  const handlePurchaseHint = async (attackId: string) => {
    if (!eventId || !teamId) return;
    setHintLoading((prev) => ({ ...prev, [attackId]: true }));
    try {
      const result = await purchaseHint(eventId, teamId, attackId);
      setHints((prev) => ({ ...prev, [attackId]: result.hint }));
    } catch {
      // ignore
    } finally {
      setHintLoading((prev) => ({ ...prev, [attackId]: false }));
    }
  };

  const handleReportFix = async (vulnerabilitySlug: string) => {
    if (!eventId || !teamId) return;
    setFixLoading((prev) => ({ ...prev, [vulnerabilitySlug]: true }));
    try {
      await reportFix(eventId, teamId, vulnerabilitySlug);
      await fetchData();
    } catch {
      // ignore
    } finally {
      setFixLoading((prev) => ({ ...prev, [vulnerabilitySlug]: false }));
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-hn-accent" />
      </div>
    );
  }

  if (error) {
    return (
      <ErrorState
        message={getErrorMessage(error)}
        type={getErrorType(error)}
        onRetry={fetchData}
      />
    );
  }

  const active = attacks.filter((a) => !a.neutralized);
  const neutralized = attacks.filter((a) => a.neutralized);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-text-primary flex items-center gap-3">
        <span className="text-hn-accent font-mono">&gt;_</span>
        防衛塹壕
      </h1>

      {/* Active attacks */}
      <div className="space-y-3">
        <h2 className="text-lg font-semibold text-text-primary">
          攻撃を受けている ({active.length})
        </h2>
        {active.length === 0 ? (
          <p className="text-text-muted text-sm py-4">
            現在攻撃を受けていません
          </p>
        ) : (
          active.map((atk) => (
            <DefenseItem
              key={atk.id}
              attack={atk}
              hint={hints[atk.attackId]}
              hintLoading={hintLoading[atk.attackId]}
              fixLoading={fixLoading[atk.attackSlug]}
              onPurchaseHint={() => handlePurchaseHint(atk.attackId)}
              onReportFix={() => handleReportFix(atk.attackSlug)}
            />
          ))
        )}
      </div>

      {/* Neutralized */}
      {neutralized.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold text-text-secondary">
            修正済み ({neutralized.length})
          </h2>
          {neutralized.map((atk) => (
            <DefenseItem key={atk.id} attack={atk} />
          ))}
        </div>
      )}
    </div>
  );
}
