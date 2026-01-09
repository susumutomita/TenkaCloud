/**
 * Rankings Page
 *
 * グローバルランキングページ
 * 全期間/月間/週間のランキングを表示
 */

'use client';

import { Crown, Medal, TrendingUp, Trophy, Users } from 'lucide-react';
import { useState } from 'react';
import { Header } from '../../components/layout';
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  Skeleton,
} from '../../components/ui';

type Period = 'all-time' | 'monthly' | 'weekly';

interface RankingEntry {
  rank: number;
  participantId: string;
  name: string;
  totalScore: number;
  eventsParticipated: number;
  trend?: 'up' | 'down' | 'same';
}

// TODO: バックエンドAPI接続後に実データに置き換え
const mockRankings: RankingEntry[] = [
  {
    rank: 1,
    participantId: '1',
    name: 'クラウドマスター',
    totalScore: 15000,
    eventsParticipated: 12,
    trend: 'same',
  },
  {
    rank: 2,
    participantId: '2',
    name: 'インフラ職人',
    totalScore: 14200,
    eventsParticipated: 10,
    trend: 'up',
  },
  {
    rank: 3,
    participantId: '3',
    name: 'サーバーレス忍者',
    totalScore: 13800,
    eventsParticipated: 11,
    trend: 'down',
  },
  {
    rank: 4,
    participantId: '4',
    name: 'コンテナ使い',
    totalScore: 12500,
    eventsParticipated: 9,
    trend: 'up',
  },
  {
    rank: 5,
    participantId: '5',
    name: 'ネットワーク達人',
    totalScore: 11800,
    eventsParticipated: 8,
    trend: 'same',
  },
];

export default function RankingsPage() {
  const [period, setPeriod] = useState<Period>('all-time');
  const [loading] = useState(false);

  const periodLabels: Record<Period, string> = {
    'all-time': '全期間',
    monthly: '月間',
    weekly: '週間',
  };

  const getRankStyle = (rank: number) => {
    switch (rank) {
      case 1:
        return 'bg-hn-warning/20 border-hn-warning';
      case 2:
        return 'bg-text-muted/20 border-text-muted';
      case 3:
        return 'bg-amber-500/20 border-amber-500';
      default:
        return 'bg-surface-1 border-border';
    }
  };

  const getRankIcon = (rank: number) => {
    switch (rank) {
      case 1:
        return <Crown className="w-6 h-6 text-hn-warning" />;
      case 2:
        return <Medal className="w-6 h-6 text-text-secondary" />;
      case 3:
        return <Medal className="w-6 h-6 text-amber-400" />;
      default:
        return (
          <span className="text-lg font-bold text-text-primary">#{rank}</span>
        );
    }
  };

  const getTrendIcon = (trend?: 'up' | 'down' | 'same') => {
    switch (trend) {
      case 'up':
        return <span className="text-hn-success">↑</span>;
      case 'down':
        return <span className="text-hn-error">↓</span>;
      default:
        return <span className="text-text-muted">-</span>;
    }
  };

  return (
    <div className="min-h-screen bg-surface-0">
      <Header />

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Page Header */}
        <div className="flex flex-col md:flex-row md:items-center md:justify-between mb-8">
          <div className="flex items-center gap-3 mb-4 md:mb-0">
            <div className="w-12 h-12 rounded-xl bg-hn-accent/20 flex items-center justify-center">
              <Trophy className="w-6 h-6 text-hn-accent" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-text-primary">
                ランキング
              </h1>
              <p className="text-text-secondary">
                クラウドエンジニアの頂点を目指せ
              </p>
            </div>
          </div>

          {/* Period Filter */}
          <div className="flex gap-2">
            {(Object.keys(periodLabels) as Period[]).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPeriod(p)}
                className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                  period === p
                    ? 'bg-hn-accent text-surface-0'
                    : 'bg-surface-1 text-text-secondary hover:text-text-primary hover:bg-surface-2'
                }`}
              >
                {periodLabels[p]}
              </button>
            ))}
          </div>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
          <Card>
            <CardContent className="flex items-center gap-4 py-4">
              <div className="w-12 h-12 rounded-xl bg-hn-success/20 flex items-center justify-center">
                <Users className="w-6 h-6 text-hn-success" />
              </div>
              <div>
                <div className="text-2xl font-bold text-text-primary">
                  {loading ? <Skeleton className="h-8 w-16" /> : '128'}
                </div>
                <div className="text-sm text-text-muted">総参加者数</div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="flex items-center gap-4 py-4">
              <div className="w-12 h-12 rounded-xl bg-hn-info/20 flex items-center justify-center">
                <Trophy className="w-6 h-6 text-hn-info" />
              </div>
              <div>
                <div className="text-2xl font-bold text-text-primary">
                  {loading ? <Skeleton className="h-8 w-16" /> : '24'}
                </div>
                <div className="text-sm text-text-muted">開催イベント数</div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="flex items-center gap-4 py-4">
              <div className="w-12 h-12 rounded-xl bg-hn-purple/20 flex items-center justify-center">
                <TrendingUp className="w-6 h-6 text-hn-purple" />
              </div>
              <div>
                <div className="text-2xl font-bold text-text-primary">
                  {loading ? <Skeleton className="h-8 w-16" /> : '15,000'}
                </div>
                <div className="text-sm text-text-muted">最高スコア</div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Rankings Table */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <span className="font-semibold text-text-primary">
                {periodLabels[period]}ランキング
              </span>
              <Badge variant="default">Top 50</Badge>
            </div>
          </CardHeader>

          {loading ? (
            <div className="p-6 space-y-4">
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-surface-2 border-b border-border">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-text-muted uppercase tracking-wider">
                      順位
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-text-muted uppercase tracking-wider">
                      名前
                    </th>
                    <th className="px-6 py-3 text-center text-xs font-medium text-text-muted uppercase tracking-wider">
                      参加イベント
                    </th>
                    <th className="px-6 py-3 text-right text-xs font-medium text-text-muted uppercase tracking-wider">
                      合計スコア
                    </th>
                    <th className="px-6 py-3 text-center text-xs font-medium text-text-muted uppercase tracking-wider">
                      推移
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {mockRankings.map((entry) => (
                    <tr
                      key={entry.participantId}
                      className={`${getRankStyle(entry.rank)} border-l-4 transition-colors hover:bg-surface-2/50`}
                    >
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="flex items-center justify-center w-10">
                          {getRankIcon(entry.rank)}
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-full bg-hn-accent/20 flex items-center justify-center">
                            <span className="text-hn-accent font-bold">
                              {entry.name.charAt(0)}
                            </span>
                          </div>
                          <span className="font-medium text-text-primary">
                            {entry.name}
                          </span>
                        </div>
                      </td>
                      <td className="px-6 py-4 text-center whitespace-nowrap">
                        <span className="text-text-secondary">
                          {entry.eventsParticipated}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-right whitespace-nowrap">
                        <span className="text-lg font-bold text-text-primary">
                          {entry.totalScore.toLocaleString()}
                        </span>
                        <span className="text-text-muted ml-1">pts</span>
                      </td>
                      <td className="px-6 py-4 text-center whitespace-nowrap text-xl">
                        {getTrendIcon(entry.trend)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {/* Empty State */}
        {!loading && mockRankings.length === 0 && (
          <Card className="text-center py-12">
            <div className="text-4xl mb-4">🏆</div>
            <h2 className="text-xl font-semibold text-text-primary mb-2">
              ランキングデータがありません
            </h2>
            <p className="text-text-secondary">
              イベントに参加してランキングに載ろう！
            </p>
          </Card>
        )}
      </main>
    </div>
  );
}
