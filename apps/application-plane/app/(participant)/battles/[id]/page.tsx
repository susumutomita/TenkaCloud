/**
 * Battle Detail Page
 *
 * バトル詳細ページ
 */

'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Header } from '@/components/layout';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  DifficultyBadge,
  EventStatusBadge,
  ProblemTypeBadge,
  ScoreProgress,
} from '@/components/ui';
import {
  getEventDetails,
  getLeaderboard,
  registerForEvent,
} from '@/lib/api/events';
import type {
  ChallengeProblem,
  EventDetails,
  Leaderboard,
} from '@/lib/api/types';

function formatDate(dateString: string) {
  const date = new Date(dateString);
  return date.toLocaleDateString('ja-JP', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function getEventDuration(start: string, end: string) {
  const diff = new Date(end).getTime() - new Date(start).getTime();
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  return hours > 0
    ? `${hours}時間${minutes > 0 ? ` ${minutes}分` : ''}`
    : `${minutes}分`;
}

export default function BattleDetailPage() {
  const params = useParams();
  const router = useRouter();
  const battleId = params.id as string;

  const [battle, setBattle] = useState<EventDetails | null>(null);
  const [leaderboard, setLeaderboard] = useState<Leaderboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [registering, setRegistering] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchData() {
      try {
        setLoading(true);
        const [battleData, leaderboardData] = await Promise.all([
          getEventDetails(battleId),
          getLeaderboard(battleId),
        ]);

        if (!battleData) {
          router.push('/battles');
          return;
        }

        setBattle(battleData);
        setLeaderboard(leaderboardData);
      } catch (err) {
        setError(err instanceof Error ? err.message : '読み込みに失敗しました');
      } finally {
        setLoading(false);
      }
    }

    fetchData();
  }, [battleId, router]);

  const handleRegister = async () => {
    if (!battle) return;

    try {
      setRegistering(true);
      await registerForEvent(battleId);
      const updatedBattle = await getEventDetails(battleId);
      if (updatedBattle) {
        setBattle(updatedBattle);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '登録に失敗しました');
    } finally {
      setRegistering(false);
    }
  };

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
    return (
      <div className="min-h-screen bg-surface-0">
        <Header />
        <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <Card className="p-8 text-center">
            <p className="text-hn-error mb-4">
              {error || 'バトルが見つかりません'}
            </p>
            <Link href="/battles">
              <Button>バトル一覧に戻る</Button>
            </Link>
          </Card>
        </main>
      </div>
    );
  }

  const isActive = battle.status === 'active';
  const canParticipate = battle.isRegistered && isActive;

  return (
    <div className="min-h-screen bg-surface-0">
      <Header />

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Breadcrumb */}
        <nav className="mb-6">
          <Link
            href="/battles"
            className="text-hn-accent hover:text-hn-accent-bright transition-colors"
          >
            ← バトル一覧
          </Link>
        </nav>

        {/* Battle Header */}
        <div className="mb-8">
          <div className="flex flex-wrap items-center gap-3 mb-4">
            <ProblemTypeBadge type={battle.type} />
            <EventStatusBadge status={battle.status} />
            {battle.isRegistered && <Badge variant="success">登録済み</Badge>}
          </div>
          <h1 className="text-3xl font-bold text-text-primary mb-4">
            {battle.name}
          </h1>
          <div className="flex flex-wrap gap-6 text-text-secondary">
            <div>
              <span className="font-medium">開始:</span>{' '}
              {formatDate(battle.startTime)}
            </div>
            <div>
              <span className="font-medium">終了:</span>{' '}
              {formatDate(battle.endTime)}
            </div>
            <div>
              <span className="font-medium">期間:</span>{' '}
              {getEventDuration(battle.startTime, battle.endTime)}
            </div>
          </div>
        </div>

        <div className="grid gap-8 lg:grid-cols-3">
          {/* Main Content */}
          <div className="lg:col-span-2 space-y-6">
            {/* Problems List */}
            {isActive && (
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <h2 className="text-xl font-semibold text-text-primary">
                      問題一覧 ({battle.problemCount}問)
                    </h2>
                    {canParticipate && (
                      <Link href={`/battles/${battleId}/problems`}>
                        <Button variant="ghost" size="sm">
                          すべて見る →
                        </Button>
                      </Link>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  {battle.problems.length === 0 ? (
                    <p className="text-text-muted text-center py-8">
                      問題はイベント開始時に公開されます
                    </p>
                  ) : (
                    battle.problems.map((problem: ChallengeProblem) => (
                      <ProblemCard
                        key={problem.id}
                        problem={problem}
                        battleId={battleId}
                        canAccess={canParticipate && problem.isUnlocked}
                      />
                    ))
                  )}
                </CardContent>
              </Card>
            )}

            {/* Team Info */}
            {battle.participantType === 'team' && battle.teamInfo && (
              <Card>
                <CardHeader>
                  <h2 className="text-xl font-semibold text-text-primary">
                    チーム情報
                  </h2>
                </CardHeader>
                <CardContent>
                  <div className="space-y-4">
                    <div>
                      <h3 className="font-medium text-text-primary">
                        {battle.teamInfo.name}
                      </h3>
                      <p className="text-sm text-text-muted">
                        メンバー: {battle.teamInfo.members.length}人
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {battle.teamInfo.members.map((member) => (
                        <span
                          key={member.id}
                          className="px-3 py-1 bg-surface-2 rounded-full text-sm text-text-secondary"
                        >
                          {member.name}
                          {member.role === 'captain' && ' (captain)'}
                        </span>
                      ))}
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>

          {/* Sidebar */}
          <div className="space-y-6">
            {/* Action Card */}
            <Card>
              <CardContent className="space-y-4">
                <div className="text-center">
                  {battle.myRank && (
                    <div className="mb-4">
                      <div className="text-4xl font-bold text-hn-accent">
                        #{battle.myRank}
                      </div>
                      <div className="text-text-muted">
                        {battle.myScore} pts
                      </div>
                    </div>
                  )}

                  {!battle.isRegistered && battle.status !== 'completed' && (
                    <Button
                      onClick={handleRegister}
                      loading={registering}
                      fullWidth
                      size="lg"
                    >
                      {battle.participantType === 'team'
                        ? 'チームで登録'
                        : '参加登録'}
                    </Button>
                  )}

                  {canParticipate && (
                    <Link href={`/battles/${battleId}/problems`}>
                      <Button fullWidth size="lg">
                        問題に挑戦
                      </Button>
                    </Link>
                  )}

                  {battle.isRegistered && !isActive && (
                    <p className="text-text-secondary">
                      バトル開始をお待ちください
                    </p>
                  )}
                </div>

                <div className="border-t border-border pt-4 space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-text-muted">参加者数</span>
                    <span className="font-medium text-text-primary">
                      {battle.participantCount}人
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-text-muted">参加形式</span>
                    <span className="font-medium text-text-primary">
                      {battle.participantType === 'team' ? 'チーム' : '個人'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-text-muted">クラウド</span>
                    <span className="font-medium text-text-primary">
                      {battle.cloudProvider.toUpperCase()}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-text-muted">採点方式</span>
                    <span className="font-medium text-text-primary">
                      {battle.scoringType === 'realtime'
                        ? 'リアルタイム'
                        : 'バッチ'}
                    </span>
                  </div>
                </div>

                {/* Quick Links */}
                {battle.isRegistered && (
                  <div className="border-t border-border pt-4 space-y-2">
                    <Link href={`/battles/${battleId}/scores`}>
                      <Button variant="ghost" fullWidth size="sm">
                        スコアを見る
                      </Button>
                    </Link>
                    <Link href={`/battles/${battleId}/leaderboard`}>
                      <Button variant="ghost" fullWidth size="sm">
                        リーダーボード
                      </Button>
                    </Link>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Leaderboard Preview */}
            {leaderboard && battle.leaderboardVisible && (
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <h2 className="font-semibold text-text-primary">
                      リーダーボード
                    </h2>
                    {leaderboard.isFrozen && (
                      <Badge variant="warning" size="sm">
                        凍結中
                      </Badge>
                    )}
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {leaderboard.entries.slice(0, 5).map((entry) => (
                      <div
                        key={entry.teamId || entry.participantId}
                        className={`flex items-center justify-between p-2 rounded ${
                          entry.isMe ? 'bg-hn-accent/10' : ''
                        }`}
                      >
                        <div className="flex items-center gap-3">
                          <span
                            className={`font-bold ${
                              entry.rank === 1
                                ? 'text-hn-warning'
                                : entry.rank === 2
                                  ? 'text-text-muted'
                                  : entry.rank === 3
                                    ? 'text-amber-500'
                                    : 'text-text-muted'
                            }`}
                          >
                            #{entry.rank}
                          </span>
                          <span
                            className={
                              entry.isMe
                                ? 'font-medium text-text-primary'
                                : 'text-text-secondary'
                            }
                          >
                            {entry.name}
                            {entry.isMe && ' (自分)'}
                          </span>
                        </div>
                        <span className="font-medium text-text-primary">
                          {entry.totalScore}
                        </span>
                      </div>
                    ))}
                  </div>
                </CardContent>
                <CardFooter>
                  <Link
                    href={`/battles/${battleId}/leaderboard`}
                    className="text-hn-accent hover:text-hn-accent-bright text-sm font-medium transition-colors"
                  >
                    全ランキングを見る →
                  </Link>
                </CardFooter>
              </Card>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

function ProblemCard({
  problem,
  battleId,
  canAccess,
}: {
  problem: ChallengeProblem;
  battleId: string;
  canAccess: boolean;
}) {
  return (
    <div
      className={`p-4 border border-border rounded-lg ${
        canAccess ? 'hover:border-hn-accent cursor-pointer' : 'opacity-75'
      } ${problem.isCompleted ? 'bg-hn-success/5 border-hn-success/30' : 'bg-surface-1'}`}
    >
      <Link
        href={canAccess ? `/battles/${battleId}/problems/${problem.id}` : '#'}
        className={canAccess ? '' : 'pointer-events-none'}
      >
        <div className="flex items-start justify-between">
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-text-muted font-medium">
                #{problem.order}
              </span>
              <DifficultyBadge difficulty={problem.difficulty} />
              {!problem.isUnlocked && (
                <Badge variant="default" size="sm">
                  ロック中
                </Badge>
              )}
              {problem.isCompleted && (
                <Badge variant="success" size="sm">
                  完了
                </Badge>
              )}
            </div>
            <h3 className="font-semibold text-text-primary">{problem.title}</h3>
            <p className="text-sm text-text-secondary mt-1 line-clamp-2">
              {problem.overview}
            </p>
          </div>
          <div className="text-right ml-4">
            <div className="text-lg font-bold text-hn-accent">
              {problem.maxScore * problem.pointMultiplier}
            </div>
            <div className="text-xs text-text-muted">pts</div>
          </div>
        </div>

        {problem.myScore !== undefined && problem.myScore > 0 && (
          <div className="mt-3">
            <ScoreProgress
              score={problem.myScore}
              maxScore={problem.maxScore * problem.pointMultiplier}
              size="sm"
            />
          </div>
        )}
      </Link>
    </div>
  );
}
