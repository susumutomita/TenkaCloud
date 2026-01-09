/**
 * Admin Participants Page
 *
 * HybridNext Design System - Terminal Command Center style
 * 参加者管理
 */

'use client';

import { useEffect, useId, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui';
import type {
  AdminParticipant,
  ParticipantStatus,
} from '@/lib/api/admin-types';

export default function AdminParticipantsPage() {
  const [participants, setParticipants] = useState<AdminParticipant[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputId = useId();

  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchParticipants = async () => {
      try {
        setLoading(true);
        setError(null);

        const params = new URLSearchParams();
        if (searchQuery) params.set('search', searchQuery);

        const response = await fetch(
          `/api/admin/participants?${params.toString()}`
        );
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(
            errorData.error || `参加者の取得に失敗しました (${response.status})`
          );
        }

        const data = await response.json();
        setParticipants(data.participants || []);
      } catch (err) {
        console.error('Failed to fetch participants:', err);
        setError(
          err instanceof Error ? err.message : '参加者の取得に失敗しました'
        );
        setParticipants([]);
      } finally {
        setLoading(false);
      }
    };

    // デバウンス用のタイマー
    const timeoutId = setTimeout(fetchParticipants, searchQuery ? 300 : 0);
    return () => clearTimeout(timeoutId);
  }, [searchQuery]);

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('ja-JP', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  // API がフィルタリングするため、クライアント側ではそのまま使用
  const filteredParticipants = participants;

  const getStatusBadgeVariant = (
    status: ParticipantStatus
  ): 'default' | 'success' | 'warning' | 'danger' => {
    switch (status) {
      case 'active':
        return 'success';
      case 'inactive':
        return 'warning';
      case 'banned':
        return 'danger';
      default:
        return 'default';
    }
  };

  const getStatusLabel = (status: ParticipantStatus): string => {
    switch (status) {
      case 'active':
        return 'アクティブ';
      case 'inactive':
        return '非アクティブ';
      case 'banned':
        return 'BAN';
      default:
        return status;
    }
  };

  const activeCount = participants.filter((p) => p.status === 'active').length;
  const avgScore =
    participants.length > 0
      ? Math.round(
          participants.reduce((acc, p) => acc + (p.totalScore || 0), 0) /
            participants.length
        )
      : 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-text-primary flex items-center gap-3">
          <span className="text-hn-accent font-mono">&gt;_</span>
          参加者管理
        </h1>
        <Button>
          <svg
            className="w-5 h-5 mr-2"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z"
            />
          </svg>
          参加者を招待
        </Button>
      </div>

      {/* Search */}
      <Card>
        <CardContent className="p-4">
          <div className="max-w-md">
            <label htmlFor={searchInputId} className="sr-only">
              検索
            </label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <svg
                  className="h-5 w-5 text-text-muted"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                  />
                </svg>
              </div>
              <input
                id={searchInputId}
                type="text"
                placeholder="名前またはメールアドレスで検索..."
                className="block w-full pl-10 pr-3 py-2 bg-surface-1 border border-border rounded-[var(--radius)] text-text-primary placeholder:text-text-muted focus:ring-hn-accent focus:border-hn-accent focus:outline-none"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card>
          <CardContent className="p-6">
            <div className="text-sm font-medium text-text-muted">
              総参加者数
            </div>
            <div className="text-3xl font-bold text-text-primary mt-1 font-mono">
              {participants.length}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <div className="text-sm font-medium text-text-muted">
              アクティブユーザー
            </div>
            <div className="text-3xl font-bold text-hn-success mt-1 font-mono">
              {activeCount}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <div className="text-sm font-medium text-text-muted">
              平均スコア
            </div>
            <div className="text-3xl font-bold text-hn-accent mt-1 font-mono">
              {avgScore.toLocaleString()}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Error State */}
      {error && (
        <Card className="border-hn-error/50 bg-hn-error/10">
          <CardContent className="p-6 text-center">
            <div className="text-4xl mb-4">⚠️</div>
            <h2 className="text-xl font-semibold text-hn-error mb-2">
              エラーが発生しました
            </h2>
            <p className="text-text-muted mb-4">{error}</p>
            <Button variant="secondary" onClick={() => setSearchQuery('')}>
              再読み込み
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Participants List */}
      {!error && loading ? (
        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="p-6">
                <div className="flex items-center gap-4">
                  <Skeleton className="h-10 w-10 rounded-full" />
                  <div className="space-y-2">
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="h-3 w-48" />
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : !error && filteredParticipants.length === 0 ? (
        <Card className="text-center py-12">
          <div className="text-4xl mb-4">👥</div>
          <h2 className="text-xl font-semibold text-text-primary mb-2">
            参加者が見つかりません
          </h2>
          <p className="text-text-muted mb-6">
            {searchQuery
              ? '検索条件を変更してください。'
              : '参加者を招待して始めましょう。'}
          </p>
          <Button>参加者を招待</Button>
        </Card>
      ) : !error ? (
        <div className="space-y-3">
          {filteredParticipants.map((participant) => (
            <Card
              key={participant.id}
              className="group hover:border-hn-accent/50 transition-all duration-[var(--animation-duration-fast)]"
            >
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div className="w-10 h-10 bg-hn-accent rounded-full flex items-center justify-center text-surface-0 font-bold">
                      {participant.displayName.charAt(0)}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-text-primary">
                          {participant.displayName}
                        </span>
                        <Badge
                          variant={getStatusBadgeVariant(participant.status)}
                        >
                          {getStatusLabel(participant.status)}
                        </Badge>
                        {participant.role === 'admin' && (
                          <Badge variant="default">管理者</Badge>
                        )}
                      </div>
                      <div className="text-sm text-text-muted">
                        {participant.email}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-6">
                    <div className="text-right">
                      <div className="text-sm text-text-muted">イベント</div>
                      <div className="font-mono text-text-primary">
                        {participant.eventsCount || 0}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-sm text-text-muted">スコア</div>
                      <div className="font-mono text-hn-accent">
                        {(participant.totalScore || 0).toLocaleString()}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-sm text-text-muted">登録日</div>
                      <div className="font-mono text-text-secondary text-sm">
                        {formatDate(participant.joinedAt)}
                      </div>
                    </div>
                    <Button variant="ghost" size="sm">
                      詳細
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : null}

      {/* Terminal-style footer */}
      <div className="text-center text-text-muted text-xs font-mono py-4">
        <span className="text-hn-accent">$</span> participants --list --count=
        {filteredParticipants.length}
      </div>
    </div>
  );
}
