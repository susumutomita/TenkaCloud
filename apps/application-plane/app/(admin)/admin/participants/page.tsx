/**
 * Admin Participants Page
 *
 * HybridNext Design System - Terminal Command Center style
 * 参加者管理
 */

'use client';

import { useEffect, useState } from 'react';
import {
  AdminPageFooter,
  AdminPageHeader,
  EmptyState,
  SearchInput,
  StatCard,
} from '@/components/admin';
import { Badge, Skeleton } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import type {
  AdminParticipant,
  ParticipantStatus,
} from '@/lib/api/admin-types';
import { formatDate } from '@/lib/utils';

export default function AdminParticipantsPage() {
  const [participants, setParticipants] = useState<AdminParticipant[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchParticipants() {
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
    }

    // デバウンス用のタイマー
    const timeoutId = setTimeout(fetchParticipants, searchQuery ? 300 : 0);
    return () => clearTimeout(timeoutId);
  }, [searchQuery]);

  // API がフィルタリングするため、クライアント側ではそのまま使用
  const filteredParticipants = participants;

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
      <AdminPageHeader
        title="参加者管理"
        actions={
          <Button>
            <UserPlusIcon className="w-5 h-5 mr-2" />
            参加者を招待
          </Button>
        }
      />

      <SearchInput
        value={searchQuery}
        onChange={setSearchQuery}
        placeholder="名前またはメールアドレスで検索..."
      />

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <StatCard label="総参加者数" value={participants.length} />
        <StatCard
          label="アクティブユーザー"
          value={activeCount}
          valueClassName="text-hn-success"
        />
        <StatCard
          label="平均スコア"
          value={avgScore}
          valueClassName="text-hn-accent"
        />
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
        <ParticipantsLoadingSkeleton />
      ) : !error && filteredParticipants.length === 0 ? (
        <EmptyState
          icon="👥"
          title="参加者が見つかりません"
          description={
            searchQuery
              ? '検索条件を変更してください。'
              : '参加者を招待して始めましょう。'
          }
          action={<Button>参加者を招待</Button>}
        />
      ) : !error ? (
        <div className="space-y-3">
          {filteredParticipants.map((participant) => (
            <ParticipantCard key={participant.id} participant={participant} />
          ))}
        </div>
      ) : null}

      <AdminPageFooter
        command="participants"
        count={filteredParticipants.length}
      />
    </div>
  );
}

function ParticipantsLoadingSkeleton() {
  return (
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
  );
}

interface ParticipantCardProps {
  participant: AdminParticipant;
}

function ParticipantCard({ participant }: ParticipantCardProps) {
  return (
    <Card className="group hover:border-hn-accent/50 transition-all duration-[var(--animation-duration-fast)]">
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
                <ParticipantStatusBadge status={participant.status} />
                {participant.role === 'admin' && (
                  <Badge variant="default">管理者</Badge>
                )}
              </div>
              <div className="text-sm text-text-muted">{participant.email}</div>
            </div>
          </div>
          <div className="flex items-center gap-6">
            <ParticipantStat
              label="イベント"
              value={participant.eventsCount || 0}
            />
            <ParticipantStat
              label="スコア"
              value={(participant.totalScore || 0).toLocaleString()}
              valueClassName="text-hn-accent"
            />
            <ParticipantStat
              label="登録日"
              value={formatDate(participant.joinedAt)}
              valueClassName="text-text-secondary text-sm"
            />
            <Button variant="ghost" size="sm">
              詳細
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

interface ParticipantStatProps {
  label: string;
  value: string | number;
  valueClassName?: string;
}

function ParticipantStat({
  label,
  value,
  valueClassName = 'text-text-primary',
}: ParticipantStatProps) {
  return (
    <div className="text-right">
      <div className="text-sm text-text-muted">{label}</div>
      <div className={`font-mono ${valueClassName}`}>{value}</div>
    </div>
  );
}

interface ParticipantStatusBadgeProps {
  status: ParticipantStatus;
}

function ParticipantStatusBadge({ status }: ParticipantStatusBadgeProps) {
  const config: Record<
    ParticipantStatus,
    { variant: 'success' | 'warning' | 'danger'; label: string }
  > = {
    active: { variant: 'success', label: 'アクティブ' },
    inactive: { variant: 'warning', label: '非アクティブ' },
    banned: { variant: 'danger', label: 'BAN' },
  };

  const { variant, label } = config[status] || {
    variant: 'default' as const,
    label: status,
  };

  return <Badge variant={variant}>{label}</Badge>;
}

function UserPlusIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z"
      />
    </svg>
  );
}
