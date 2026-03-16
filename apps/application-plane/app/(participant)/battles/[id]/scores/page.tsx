/**
 * Scores Page
 *
 * 自分のスコア表示ページ - SSE でリアルタイム更新
 */

'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Header } from '@/components/layout';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  ErrorState,
  getErrorMessage,
  getErrorType,
  ScoreProgress,
} from '@/components/ui';
import { getEventDetails, getMyRanking } from '@/lib/api/events';
import type { EventDetails } from '@/lib/api/types';

const API_BASE_URL = '/api';

interface MyScore {
  rank: number;
  totalScore: number;
  problemScores: Record<string, number>;
}

export default function ScoresPage() {
  const params = useParams();
  const battleId = params.id as string;

  const [battle, setBattle] = useState<EventDetails | null>(null);
  const [myScore, setMyScore] = useState<MyScore | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [sseConnected, setSseConnected] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);

  const connectSSE = useCallback(() => {
    const url = `${API_BASE_URL}/participant/events/${battleId}/scores/stream`;
    const es = new EventSource(url);
    eventSourceRef.current = es;

    es.onopen = () => {
      setSseConnected(true);
    };

    es.addEventListener('score-update', (event) => {
      try {
        const data = JSON.parse(event.data) as MyScore;
        setMyScore(data);
      } catch {
        // ignore parse errors
      }
    });

    es.onerror = () => {
      setSseConnected(false);
      es.close();
      // Reconnect after 5 seconds
      setTimeout(() => {
        connectSSE();
      }, 5000);
    };

    return es;
  }, [battleId]);

  useEffect(() => {
    async function fetchData() {
      try {
        setLoading(true);
        const [battleData, ranking] = await Promise.all([
          getEventDetails(battleId),
          getMyRanking(battleId),
        ]);
        setBattle(battleData);
        if (ranking) {
          setMyScore(ranking);
        }
      } catch (err) {
        setError(
          err instanceof Error ? err : new Error('読み込みに失敗しました')
        );
      } finally {
        setLoading(false);
      }
    }

    fetchData();
  }, [battleId]);

  // SSE connection
  useEffect(() => {
    const es = connectSSE();
    return () => {
      es.close();
    };
  }, [connectSSE]);

  if (loading) {
    return (
      <div className="min-h-screen bg-surface-0">
        <Header />
        <div className="flex justify-center items-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-hn-accent" />
        </div>
      </div>
    );
  }

  if (error || !battle) {
    const displayError = error || new Error('not found');
    return (
      <div className="min-h-screen bg-surface-0">
        <Header />
        <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <ErrorState
            message={getErrorMessage(displayError)}
            type={getErrorType(displayError)}
            onRetry={() => window.location.reload()}
          />
        </main>
      </div>
    );
  }

  const totalMaxScore = battle.problems.reduce(
    (sum, p) => sum + p.maxScore * p.pointMultiplier,
    0
  );

  return (
    <div className="min-h-screen bg-surface-0">
      <Header />

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Breadcrumb */}
        <nav className="mb-6 flex items-center gap-2 text-sm">
          <Link
            href="/battles"
            className="text-hn-accent hover:text-hn-accent-bright transition-colors"
          >
            バトル一覧
          </Link>
          <span className="text-text-muted">/</span>
          <Link
            href={`/battles/${battleId}`}
            className="text-hn-accent hover:text-hn-accent-bright transition-colors"
          >
            {battle.name}
          </Link>
          <span className="text-text-muted">/</span>
          <span className="text-text-secondary">スコア</span>
        </nav>

        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold text-text-primary">マイスコア</h1>
            <p className="text-text-secondary mt-1">{battle.name}</p>
          </div>
          <div className="flex items-center gap-3">
            {sseConnected ? (
              <Badge variant="success" size="sm" dot>
                リアルタイム
              </Badge>
            ) : (
              <Badge variant="default" size="sm" dot>
                オフライン
              </Badge>
            )}
          </div>
        </div>

        {/* Total Score Card */}
        <Card className="mb-8">
          <CardContent>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-text-muted text-sm mb-1">合計スコア</div>
                <div className="text-4xl font-bold text-hn-accent">
                  {myScore?.totalScore ?? 0}
                  <span className="text-text-muted text-lg font-normal">
                    {' '}
                    / {totalMaxScore} pts
                  </span>
                </div>
              </div>
              {myScore?.rank && (
                <div className="text-center">
                  <div className="text-text-muted text-sm mb-1">順位</div>
                  <div className="text-4xl font-bold text-hn-accent">
                    #{myScore.rank}
                  </div>
                </div>
              )}
            </div>
            {totalMaxScore > 0 && (
              <div className="mt-4">
                <ScoreProgress
                  score={myScore?.totalScore ?? 0}
                  maxScore={totalMaxScore}
                />
              </div>
            )}
          </CardContent>
        </Card>

        {/* Problem Scores */}
        <Card>
          <CardHeader>
            <h2 className="text-xl font-semibold text-text-primary">
              問題別スコア
            </h2>
          </CardHeader>
          <div className="divide-y divide-border">
            {battle.problems.map((problem) => {
              const score =
                myScore?.problemScores[problem.id] ?? problem.myScore ?? 0;
              const maxScore = problem.maxScore * problem.pointMultiplier;

              return (
                <div
                  key={problem.id}
                  className="px-6 py-4 flex items-center gap-4"
                >
                  <div className="text-text-muted font-medium w-8 text-center shrink-0">
                    #{problem.order}
                  </div>
                  <div className="flex-1 min-w-0">
                    <Link
                      href={`/battles/${battleId}/problems/${problem.id}`}
                      className="font-medium text-text-primary hover:text-hn-accent transition-colors"
                    >
                      {problem.title}
                    </Link>
                    <div className="mt-2">
                      <ScoreProgress
                        score={score}
                        maxScore={maxScore}
                        size="sm"
                      />
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <span className="font-bold text-text-primary">{score}</span>
                    <span className="text-text-muted text-sm">
                      {' '}
                      / {maxScore}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>

        {/* Actions */}
        <div className="mt-6 flex justify-center gap-4">
          <Link href={`/battles/${battleId}/leaderboard`}>
            <Button variant="outline">リーダーボードを見る</Button>
          </Link>
          <Link href={`/battles/${battleId}/problems`}>
            <Button variant="ghost">問題一覧に戻る</Button>
          </Link>
        </div>
      </main>
    </div>
  );
}
