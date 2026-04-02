/**
 * Battles List Page
 *
 * 参加可能なバトル一覧ページ
 */

'use client';

import Link from 'next/link';
import { useEffect, useId, useState } from 'react';
import { Header } from '@/components/layout';
import {
  Badge,
  Button,
  Card,
  CardContent,
  DifficultyBadge,
  ErrorState,
  EventStatusBadge,
  getErrorMessage,
  getErrorType,
  ProblemTypeBadge,
} from '@/components/ui';
import { getAvailableEvents } from '@/lib/api/events';
import type {
  EventStatus,
  ParticipantEvent,
  ProblemType,
} from '@/lib/api/types';

function formatDate(dateString: string) {
  const date = new Date(dateString);
  return date.toLocaleDateString('ja-JP', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function getTimeUntilStart(startTime: string) {
  const now = new Date();
  const start = new Date(startTime);
  const diff = start.getTime() - now.getTime();

  if (diff <= 0) return null;

  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));

  if (days > 0) return `あと ${days} 日 ${hours} 時間`;
  if (hours > 0) return `あと ${hours} 時間`;
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  return `あと ${minutes} 分`;
}

export default function BattlesPage() {
  const [battles, setBattles] = useState<ParticipantEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [filter, setFilter] = useState<{
    status?: EventStatus;
    type?: ProblemType;
  }>({});
  const statusFilterId = useId();
  const typeFilterId = useId();

  useEffect(() => {
    async function fetchBattles() {
      try {
        setLoading(true);
        const statusFilter = filter.status
          ? [filter.status]
          : ['scheduled', 'active'];
        const res = await getAvailableEvents({
          status: statusFilter as EventStatus[],
          type: filter.type,
          limit: 50,
        });
        setBattles(res.events);
      } catch (err) {
        setError(
          err instanceof Error ? err : new Error('読み込みに失敗しました'),
        );
      } finally {
        setLoading(false);
      }
    }

    fetchBattles();
  }, [filter]);

  return (
    <div className="min-h-screen bg-surface-0 relative overflow-hidden">
      <div className="absolute top-0 left-0 w-full h-full overflow-hidden -z-10 pointer-events-none">
        <div className="absolute top-[-10%] right-[-5%] w-[500px] h-[500px] bg-hn-accent/10 rounded-full blur-[100px]" />
        <div className="absolute bottom-[-10%] left-[-5%] w-[500px] h-[500px] bg-hn-purple/10 rounded-full blur-[100px]" />
      </div>

      <Header />

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-2xl font-bold text-text-primary">バトル一覧</h1>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap gap-4 mb-6">
          <div>
            <label
              htmlFor={statusFilterId}
              className="block text-sm font-medium text-text-secondary mb-1"
            >
              ステータス
            </label>
            <select
              id={statusFilterId}
              className="bg-surface-1 border border-border text-text-primary rounded-lg px-3 py-2 focus:ring-hn-accent focus:border-hn-accent"
              value={filter.status || ''}
              onChange={(e) =>
                setFilter((f) => ({
                  ...f,
                  status: (e.target.value as EventStatus) || undefined,
                }))
              }
            >
              <option value="" className="bg-surface-1">
                すべて
              </option>
              <option value="active" className="bg-surface-1">
                開催中
              </option>
              <option value="scheduled" className="bg-surface-1">
                開催予定
              </option>
            </select>
          </div>
          <div>
            <label
              htmlFor={typeFilterId}
              className="block text-sm font-medium text-text-secondary mb-1"
            >
              タイプ
            </label>
            <select
              id={typeFilterId}
              className="bg-surface-1 border border-border text-text-primary rounded-lg px-3 py-2 focus:ring-hn-accent focus:border-hn-accent"
              value={filter.type || ''}
              onChange={(e) =>
                setFilter((f) => ({
                  ...f,
                  type: (e.target.value as ProblemType) || undefined,
                }))
              }
            >
              <option value="" className="bg-surface-1">
                すべて
              </option>
              <option value="gameday" className="bg-surface-1">
                GameDay
              </option>
              <option value="jam" className="bg-surface-1">
                JAM
              </option>
            </select>
          </div>
        </div>

        {loading ? (
          <div className="flex justify-center items-center h-64">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-hn-accent" />
          </div>
        ) : error ? (
          <ErrorState
            message={getErrorMessage(error)}
            type={getErrorType(error)}
            onRetry={() => window.location.reload()}
          />
        ) : battles.length === 0 ? (
          <Card className="text-center py-12">
            <h2 className="text-xl font-semibold text-text-primary mb-2">
              バトルが見つかりません
            </h2>
            <p className="text-text-muted">
              条件に一致するバトルがありません。
            </p>
          </Card>
        ) : (
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {battles.map((battle) => {
              const timeUntil =
                battle.status === 'scheduled'
                  ? getTimeUntilStart(battle.startTime)
                  : null;

              return (
                <Link
                  key={battle.id}
                  href={`/battles/${battle.id}`}
                  data-testid={`battle-card-${battle.id}`}
                >
                  <Card hoverable className="h-full">
                    <CardContent className="space-y-4">
                      <div className="flex items-start justify-between">
                        <div className="flex gap-2">
                          <ProblemTypeBadge type={battle.type} />
                          <EventStatusBadge status={battle.status} />
                        </div>
                        {battle.isRegistered && (
                          <Badge variant="success" size="sm">
                            登録済み
                          </Badge>
                        )}
                      </div>

                      <div>
                        <h3 className="font-semibold text-lg text-text-primary">
                          {battle.name}
                        </h3>
                        {timeUntil && (
                          <p className="text-hn-accent font-medium text-sm mt-1">
                            {timeUntil}
                          </p>
                        )}
                      </div>

                      <div className="text-sm text-text-secondary space-y-1">
                        <p>
                          <span className="font-medium">開始:</span>{' '}
                          {formatDate(battle.startTime)}
                        </p>
                        <p>
                          <span className="font-medium">終了:</span>{' '}
                          {formatDate(battle.endTime)}
                        </p>
                      </div>

                      <div className="flex items-center justify-between text-sm text-text-muted">
                        <span>問題数: {battle.problemCount}</span>
                        <span>参加者: {battle.participantCount}</span>
                      </div>

                      <div className="flex items-center gap-2 text-sm">
                        <span className="px-2 py-1 bg-surface-2 rounded text-text-secondary">
                          {battle.cloudProvider.toUpperCase()}
                        </span>
                        <span className="text-text-muted">
                          {battle.participantType === 'team'
                            ? 'チーム参加'
                            : '個人参加'}
                        </span>
                      </div>

                      <Button
                        variant={
                          battle.status === 'active' ? 'primary' : 'outline'
                        }
                        fullWidth
                      >
                        {battle.status === 'active'
                          ? battle.isRegistered
                            ? 'バトルに参加'
                            : '今すぐ参加'
                          : battle.isRegistered
                            ? '詳細を見る'
                            : '登録する'}
                      </Button>
                    </CardContent>
                  </Card>
                </Link>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
