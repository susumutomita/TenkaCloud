/**
 * Admin Teams Page
 *
 * HybridNext Design System - Terminal Command Center style
 * チーム管理
 */

'use client';

import { useEffect, useId, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { AdminTeam } from '@/lib/api/admin-types';

export default function AdminTeamsPage() {
  const [teams, setTeams] = useState<AdminTeam[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputId = useId();

  useEffect(() => {
    // TODO: Replace with actual API call
    const fetchTeams = async () => {
      try {
        setLoading(true);
        // Mock data
        setTeams([
          {
            id: 'team-1',
            name: 'Cloud Warriors',
            members: [],
            captainId: 'user-1',
            inviteCode: 'CW2024',
            memberCount: 4,
            maxMembers: 5,
            eventsCount: 3,
            totalScore: 8500,
            createdAt: new Date(Date.now() - 2592000000).toISOString(),
          },
          {
            id: 'team-2',
            name: 'Lambda Legends',
            members: [],
            captainId: 'user-2',
            inviteCode: 'LL2024',
            memberCount: 5,
            maxMembers: 5,
            eventsCount: 2,
            totalScore: 6200,
            createdAt: new Date(Date.now() - 1296000000).toISOString(),
          },
          {
            id: 'team-3',
            name: 'Serverless Samurai',
            members: [],
            captainId: 'user-3',
            inviteCode: 'SS2024',
            memberCount: 3,
            maxMembers: 5,
            eventsCount: 1,
            totalScore: 2100,
            createdAt: new Date(Date.now() - 604800000).toISOString(),
          },
        ]);
      } finally {
        setLoading(false);
      }
    };

    fetchTeams();
  }, []);

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('ja-JP', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  const filteredTeams = teams.filter((t) =>
    t.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const totalMembers = teams.reduce((acc, t) => acc + t.memberCount, 0);
  const avgScore =
    teams.length > 0
      ? Math.round(
          teams.reduce((acc, t) => acc + t.totalScore, 0) / teams.length
        )
      : 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-text-primary flex items-center gap-3">
          <span className="text-hn-accent font-mono">&gt;_</span>
          チーム管理
        </h1>
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
                placeholder="チーム名で検索..."
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
              総チーム数
            </div>
            <div className="text-3xl font-bold text-text-primary mt-1 font-mono">
              {teams.length}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <div className="text-sm font-medium text-text-muted">
              総メンバー数
            </div>
            <div className="text-3xl font-bold text-hn-purple mt-1 font-mono">
              {totalMembers}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <div className="text-sm font-medium text-text-muted">
              平均チームスコア
            </div>
            <div className="text-3xl font-bold text-hn-accent mt-1 font-mono">
              {avgScore.toLocaleString()}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Teams Grid */}
      {loading ? (
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
      ) : filteredTeams.length === 0 ? (
        <Card className="text-center py-12">
          <div className="text-4xl mb-4">🏆</div>
          <h2 className="text-xl font-semibold text-text-primary mb-2">
            チームが見つかりません
          </h2>
          <p className="text-text-muted">
            {searchQuery
              ? '検索条件を変更してください。'
              : '参加者がチームを作成するとここに表示されます。'}
          </p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredTeams.map((team) => (
            <Card
              key={team.id}
              className="group hover:border-hn-accent/50 transition-all duration-[var(--animation-duration-fast)]"
            >
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
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-text-muted">メンバー</span>
                    <span className="font-mono text-text-primary">
                      {team.memberCount} / {team.maxMembers}
                    </span>
                  </div>
                  <div className="w-full bg-surface-2 rounded-full h-2">
                    <div
                      className="bg-hn-accent h-2 rounded-full transition-all"
                      style={{
                        width: `${(team.memberCount / team.maxMembers) * 100}%`,
                      }}
                    />
                  </div>

                  <div className="flex items-center justify-between text-sm">
                    <span className="text-text-muted">参加イベント</span>
                    <span className="font-mono text-text-primary">
                      {team.eventsCount}
                    </span>
                  </div>

                  <div className="flex items-center justify-between text-sm">
                    <span className="text-text-muted">作成日</span>
                    <span className="font-mono text-text-secondary text-xs">
                      {formatDate(team.createdAt)}
                    </span>
                  </div>
                </div>

                <div className="mt-4 pt-4 border-t border-border">
                  <Button variant="ghost" size="sm" className="w-full">
                    詳細を見る
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Terminal-style footer */}
      <div className="text-center text-text-muted text-xs font-mono py-4">
        <span className="text-hn-accent">$</span> teams --list --count=
        {filteredTeams.length}
      </div>
    </div>
  );
}
