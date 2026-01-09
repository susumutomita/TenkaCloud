/**
 * Admin Teams Page
 *
 * HybridNext Design System - Terminal Command Center style
 * チーム管理
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
import { Skeleton } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import type { AdminTeam } from '@/lib/api/admin-types';
import { formatDate } from '@/lib/utils';

export default function AdminTeamsPage() {
  const [teams, setTeams] = useState<AdminTeam[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');

  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchTeams() {
      try {
        setLoading(true);
        setError(null);

        const params = new URLSearchParams();
        if (searchQuery) params.set('search', searchQuery);

        const response = await fetch(`/api/admin/teams?${params.toString()}`);
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(
            errorData.error || `チームの取得に失敗しました (${response.status})`
          );
        }

        const data = await response.json();
        setTeams(data.teams || []);
      } catch (err) {
        console.error('Failed to fetch teams:', err);
        setError(
          err instanceof Error ? err.message : 'チームの取得に失敗しました'
        );
        setTeams([]);
      } finally {
        setLoading(false);
      }
    }

    // デバウンス用のタイマー
    const timeoutId = setTimeout(fetchTeams, searchQuery ? 300 : 0);
    return () => clearTimeout(timeoutId);
  }, [searchQuery]);

  // API がフィルタリングするため、クライアント側ではそのまま使用
  const filteredTeams = teams;

  const totalMembers = teams.reduce((acc, t) => acc + t.memberCount, 0);
  const avgScore =
    teams.length > 0
      ? Math.round(
          teams.reduce((acc, t) => acc + t.totalScore, 0) / teams.length
        )
      : 0;

  return (
    <div className="space-y-6">
      <AdminPageHeader title="チーム管理" />

      <SearchInput
        value={searchQuery}
        onChange={setSearchQuery}
        placeholder="チーム名で検索..."
      />

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <StatCard label="総チーム数" value={teams.length} />
        <StatCard
          label="総メンバー数"
          value={totalMembers}
          valueClassName="text-hn-purple"
        />
        <StatCard
          label="平均チームスコア"
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

      {/* Teams Grid */}
      {!error && loading ? (
        <TeamsLoadingSkeleton />
      ) : !error && filteredTeams.length === 0 ? (
        <EmptyState
          icon="🏆"
          title="チームが見つかりません"
          description={
            searchQuery
              ? '検索条件を変更してください。'
              : '参加者がチームを作成するとここに表示されます。'
          }
        />
      ) : !error ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredTeams.map((team) => (
            <TeamCard key={team.id} team={team} />
          ))}
        </div>
      ) : null}

      <AdminPageFooter command="teams" count={filteredTeams.length} />
    </div>
  );
}

function TeamsLoadingSkeleton() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      {Array.from({ length: 3 }).map((_, i) => (
        <Card key={i}>
          <CardContent className="p-6">
            <Skeleton className="h-6 w-40 mb-4" />
            <div className="space-y-3">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

interface TeamCardProps {
  team: AdminTeam;
}

function TeamCard({ team }: TeamCardProps) {
  const memberPercentage = (team.memberCount / team.maxMembers) * 100;

  return (
    <Card className="group hover:border-hn-accent/50 transition-all duration-[var(--animation-duration-fast)]">
      <CardContent className="p-6">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h3 className="text-lg font-semibold text-text-primary group-hover:text-hn-accent transition-colors">
              {team.name}
            </h3>
            <p className="text-sm text-text-muted font-mono">
              #{team.inviteCode}
            </p>
          </div>
          <div className="text-right">
            <div className="text-2xl font-bold text-hn-accent font-mono">
              {team.totalScore.toLocaleString()}
            </div>
            <div className="text-xs text-text-muted">pts</div>
          </div>
        </div>

        <div className="space-y-3">
          <TeamStatRow label="メンバー">
            <span className="font-mono text-text-primary">
              {team.memberCount} / {team.maxMembers}
            </span>
          </TeamStatRow>
          <div className="w-full bg-surface-2 rounded-full h-2">
            <div
              className="bg-hn-accent h-2 rounded-full transition-all"
              style={{ width: `${memberPercentage}%` }}
            />
          </div>

          <TeamStatRow label="参加イベント">
            <span className="font-mono text-text-primary">
              {team.eventsCount}
            </span>
          </TeamStatRow>

          <TeamStatRow label="作成日">
            <span className="font-mono text-text-secondary text-xs">
              {formatDate(team.createdAt)}
            </span>
          </TeamStatRow>
        </div>

        <div className="mt-4 pt-4 border-t border-border">
          <Button variant="ghost" size="sm" className="w-full">
            詳細を見る
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

interface TeamStatRowProps {
  label: string;
  children: React.ReactNode;
}

function TeamStatRow({ label, children }: TeamStatRowProps) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-text-muted">{label}</span>
      {children}
    </div>
  );
}
