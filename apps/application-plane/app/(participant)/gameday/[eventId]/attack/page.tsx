/**
 * Attack Station (攻撃ステーション)
 *
 * 攻撃カタロググリッド、購入、ターゲット選択 + 実行、攻撃履歴テーブル
 */

'use client';

import { useCallback, useEffect, useState } from 'react';
import { AttackCard } from '@/components/gameday';
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  ErrorState,
  getErrorMessage,
  getErrorType,
  Select,
} from '@/components/ui';
import {
  executeAttack,
  getAttackCatalog,
  getAttackHistory,
  getParticipantTeams,
  purchaseAttack,
} from '@/lib/api/gameday';
import type { Attack, AttackLog, CooldownError } from '@/lib/api/gameday-types';
import { useGamedaySession } from '@/lib/hooks/use-gameday-session';

export default function AttackPage() {
  const { eventId, teamId } = useGamedaySession();
  const [catalog, setCatalog] = useState<Attack[]>([]);
  const [history, setHistory] = useState<AttackLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [purchasedIds, setPurchasedIds] = useState<Set<string>>(new Set());
  const [cooldowns, setCooldowns] = useState<Record<string, number>>({});
  const [purchasing, setPurchasing] = useState<Record<string, boolean>>({});
  const [executing, setExecuting] = useState<Record<string, boolean>>({});
  const [selectedTarget, setSelectedTarget] = useState('');
  const [teams, setTeams] = useState<{ value: string; label: string }[]>([]);

  const fetchData = useCallback(async () => {
    if (!eventId || !teamId) return;
    try {
      const [catalogData, historyData] = await Promise.all([
        getAttackCatalog(eventId),
        getAttackHistory(eventId, teamId),
      ]);
      setCatalog(catalogData.attacks);
      setHistory(historyData.history);
      setError(null);
    } catch (err) {
      setError(
        err instanceof Error ? err : new Error('読み込みに失敗しました')
      );
    } finally {
      setLoading(false);
    }
  }, [eventId, teamId]);

  // Fetch team list for target selection
  useEffect(() => {
    if (!eventId) return;
    getParticipantTeams(eventId)
      .then((data) => {
        const opts = data.teams
          .filter((team) => team.teamId !== teamId)
          .map((team) => ({
            value: team.teamId,
            label: team.teamName,
          }));
        setTeams(opts);
      })
      .catch(() => {});
  }, [eventId, teamId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handlePurchase = async (attackId: string) => {
    if (!eventId || !teamId) return;
    setPurchasing((prev) => ({ ...prev, [attackId]: true }));
    try {
      await purchaseAttack(eventId, teamId, attackId);
      setPurchasedIds((prev) => new Set(prev).add(attackId));
    } catch {
      // ignore
    } finally {
      setPurchasing((prev) => ({ ...prev, [attackId]: false }));
    }
  };

  const handleExecute = async (attackId: string) => {
    if (!eventId || !teamId || !selectedTarget) return;
    setExecuting((prev) => ({ ...prev, [attackId]: true }));
    try {
      await executeAttack(eventId, teamId, attackId, selectedTarget);
      await fetchData();
    } catch (err) {
      const e = err as Error & { status?: number; body?: CooldownError };
      if (e.status === 429 && e.body?.remainingSeconds) {
        setCooldowns((prev) => ({
          ...prev,
          [attackId]: Date.now() + (e.body?.remainingSeconds ?? 0) * 1000,
        }));
      }
    } finally {
      setExecuting((prev) => ({ ...prev, [attackId]: false }));
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

  const formatTime = (ts: string) =>
    new Date(ts).toLocaleTimeString('ja-JP', {
      hour: '2-digit',
      minute: '2-digit',
    });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-text-primary flex items-center gap-3">
          <span className="text-hn-accent font-mono">&gt;_</span>
          攻撃ステーション
        </h1>
      </div>

      {/* Target Selection */}
      <Card>
        <CardContent>
          <div className="flex items-center gap-4">
            <Select
              options={teams}
              placeholder="ターゲットチームを選択"
              value={selectedTarget}
              onChange={(e) => setSelectedTarget(e.target.value)}
              label="ターゲット"
            />
          </div>
        </CardContent>
      </Card>

      {/* Attack Catalog Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {catalog.map((attack) => (
          <AttackCard
            key={attack.id}
            attack={attack}
            purchased={purchasedIds.has(attack.id)}
            cooldownUntil={cooldowns[attack.id]}
            purchasing={purchasing[attack.id]}
            executing={executing[attack.id]}
            onPurchase={() => handlePurchase(attack.id)}
            onExecute={() => handleExecute(attack.id)}
          />
        ))}
      </div>

      {/* Attack History */}
      <Card>
        <CardHeader>
          <span className="font-semibold text-text-primary">攻撃履歴</span>
        </CardHeader>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-surface-2 border-b border-border">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-text-muted uppercase">
                  時間
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-text-muted uppercase">
                  攻撃
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-text-muted uppercase">
                  対象
                </th>
                <th className="px-4 py-3 text-center text-xs font-medium text-text-muted uppercase">
                  結果
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium text-text-muted uppercase">
                  報酬
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {history.map((log) => (
                <tr key={log.id}>
                  <td className="px-4 py-3 text-sm font-mono text-text-muted">
                    {formatTime(log.createdAt)}
                  </td>
                  <td className="px-4 py-3 text-sm text-text-primary">
                    {log.attackSlug}
                  </td>
                  <td className="px-4 py-3 text-sm text-text-secondary">
                    {log.defenderTeamId}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <Badge
                      variant={log.success ? 'success' : 'danger'}
                      badgeStyle="subtle"
                      size="sm"
                    >
                      {log.success ? '成功' : '失敗'}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-sm text-right font-mono text-hn-success">
                    {log.success ? `+${log.reward}` : '0'}
                  </td>
                </tr>
              ))}
              {history.length === 0 && (
                <tr>
                  <td
                    colSpan={5}
                    className="px-4 py-8 text-center text-text-muted text-sm"
                  >
                    攻撃履歴なし
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
