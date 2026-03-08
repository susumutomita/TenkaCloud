/**
 * Rankings Page
 *
 * グローバルランキングページ
 */

'use client';

import { Crown, Medal, TrendingUp, Trophy, User, Users } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Header } from '../../components/layout';
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  ErrorState,
  getErrorMessage,
  getErrorType,
  Skeleton,
} from '../../components/ui';
import { getGlobalRanking } from '../../lib/api/profile';

interface RankingEntry {
  rank: number;
  participantId: string;
  name: string;
  totalScore: number;
  eventsParticipated: number;
}

interface RankingData {
  rankings: RankingEntry[];
  total: number;
  myRank?: number;
}

export default function RankingsPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [data, setData] = useState<RankingData | null>(null);

  const fetchRankings = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await getGlobalRanking({ limit: 50 });
      setData({
        rankings: res.rankings.map((r) => ({
          rank: r.rank,
          participantId: r.userId,
          name: r.name,
          totalScore: r.totalScore,
          eventsParticipated: r.eventsParticipated,
        })),
        total: res.total,
        myRank: res.myRank,
      });
    } catch (err) {
      setError(
        err instanceof Error ? err : new Error('読み込みに失敗しました')
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRankings();
  }, [fetchRankings]);

  const rankings = data?.rankings ?? [];
  const totalParticipants = data?.total ?? 0;
  const topScore = rankings[0]?.totalScore;

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
        </div>

        {/* My Rank Banner */}
        {data?.myRank && (
          <div className="bg-surface-secondary border border-border rounded-lg p-4 flex items-center gap-3 mb-8">
            <User className="w-5 h-5 text-hn-accent" />
            <span className="text-text-secondary">あなたの現在の順位:</span>
            <span className="text-xl font-bold text-hn-accent">
              {data.myRank}位
            </span>
            <span className="text-text-muted">/ {data.total}人中</span>
          </div>
        )}

        {/* Stats Cards */}
        {!error && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
            <Card>
              <CardContent className="flex items-center gap-4 py-4">
                <div className="w-12 h-12 rounded-xl bg-hn-success/20 flex items-center justify-center">
                  <Users className="w-6 h-6 text-hn-success" />
                </div>
                <div>
                  <div className="text-2xl font-bold text-text-primary">
                    {loading ? (
                      <Skeleton className="h-8 w-16" />
                    ) : (
                      totalParticipants.toLocaleString()
                    )}
                  </div>
                  <div className="text-sm text-text-muted">総参加者数</div>
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
                    {loading ? (
                      <Skeleton className="h-8 w-16" />
                    ) : topScore !== undefined ? (
                      topScore.toLocaleString()
                    ) : (
                      '-'
                    )}
                  </div>
                  <div className="text-sm text-text-muted">最高スコア</div>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Error State */}
        {error && (
          <ErrorState
            message={getErrorMessage(error)}
            type={getErrorType(error)}
            onRetry={fetchRankings}
          />
        )}

        {/* Rankings Table */}
        {!error && (
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <span className="font-semibold text-text-primary">
                  ランキング
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
            ) : rankings.length === 0 ? (
              <div className="text-center py-12 px-6">
                <Trophy className="w-12 h-12 text-text-muted mx-auto mb-4" />
                <h2 className="text-xl font-semibold text-text-primary mb-2">
                  ランキングデータがありません
                </h2>
                <p className="text-text-secondary">
                  イベントに参加してランキングに載ろう！
                </p>
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
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {rankings.map((entry) => (
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
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        )}
      </main>
    </div>
  );
}
