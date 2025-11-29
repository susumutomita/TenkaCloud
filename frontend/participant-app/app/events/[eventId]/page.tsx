/**
 * Event Detail Page
 *
 * イベント詳細ページ
 */

'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Header } from '../../../components/layout';
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
} from '../../../components/ui';
import {
  getEventDetails,
  getLeaderboard,
  registerForEvent,
} from '../../../lib/api/events';
import type {
  ChallengeProblem,
  EventDetails,
  Leaderboard,
} from '../../../lib/api/types';

export default function EventDetailPage() {
  const params = useParams();
  const router = useRouter();
  const eventId = params.eventId as string;

  const [event, setEvent] = useState<EventDetails | null>(null);
  const [leaderboard, setLeaderboard] = useState<Leaderboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [registering, setRegistering] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchData() {
      try {
        setLoading(true);
        const [eventData, leaderboardData] = await Promise.all([
          getEventDetails(eventId),
          getLeaderboard(eventId),
        ]);

        if (!eventData) {
          router.push('/events');
          return;
        }

        setEvent(eventData);
        setLeaderboard(leaderboardData);
      } catch (err) {
        setError(err instanceof Error ? err.message : '読み込みに失敗しました');
      } finally {
        setLoading(false);
      }
    }

    fetchData();
  }, [eventId, router]);

  const handleRegister = async () => {
    if (!event) return;

    try {
      setRegistering(true);
      await registerForEvent(eventId);
      // Refresh event data
      const updatedEvent = await getEventDetails(eventId);
      if (updatedEvent) {
        setEvent(updatedEvent);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '登録に失敗しました');
    } finally {
      setRegistering(false);
    }
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('ja-JP', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const getEventDuration = (start: string, end: string) => {
    const diff = new Date(end).getTime() - new Date(start).getTime();
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    return hours > 0
      ? `${hours}時間${minutes > 0 ? ` ${minutes}分` : ''}`
      : `${minutes}分`;
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50">
        <Header userName="参加者" />
        <div className="flex justify-center items-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
        </div>
      </div>
    );
  }

  if (error || !event) {
    return (
      <div className="min-h-screen bg-gray-50">
        <Header userName="参加者" />
        <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <Card className="p-8 text-center">
            <p className="text-red-600 mb-4">
              {error || 'イベントが見つかりません'}
            </p>
            <Link href="/events">
              <Button>イベント一覧に戻る</Button>
            </Link>
          </Card>
        </main>
      </div>
    );
  }

  const isActive = event.status === 'active';
  const canParticipate = event.isRegistered && isActive;

  return (
    <div className="min-h-screen bg-gray-50">
      <Header userName="参加者" />

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Breadcrumb */}
        <nav className="mb-6">
          <Link href="/events" className="text-blue-600 hover:text-blue-700">
            ← イベント一覧
          </Link>
        </nav>

        {/* Event Header */}
        <div className="mb-8">
          <div className="flex flex-wrap items-center gap-3 mb-4">
            <ProblemTypeBadge type={event.type} />
            <EventStatusBadge status={event.status} />
            {event.isRegistered && <Badge variant="success">登録済み</Badge>}
          </div>
          <h1 className="text-3xl font-bold text-gray-900 mb-4">
            {event.name}
          </h1>
          <div className="flex flex-wrap gap-6 text-gray-600">
            <div>
              <span className="font-medium">開始:</span>{' '}
              {formatDate(event.startTime)}
            </div>
            <div>
              <span className="font-medium">終了:</span>{' '}
              {formatDate(event.endTime)}
            </div>
            <div>
              <span className="font-medium">期間:</span>{' '}
              {getEventDuration(event.startTime, event.endTime)}
            </div>
          </div>
        </div>

        <div className="grid gap-8 lg:grid-cols-3">
          {/* Main Content */}
          <div className="lg:col-span-2 space-y-6">
            {/* Problems List */}
            <Card>
              <CardHeader>
                <h2 className="text-xl font-semibold">
                  問題一覧 ({event.problemCount}問)
                </h2>
              </CardHeader>
              <CardContent className="space-y-4">
                {event.problems.length === 0 ? (
                  <p className="text-gray-500 text-center py-8">
                    {isActive
                      ? '問題の読み込み中...'
                      : '問題はイベント開始時に公開されます'}
                  </p>
                ) : (
                  event.problems.map((problem: ChallengeProblem) => (
                    <ProblemCard
                      key={problem.id}
                      problem={problem}
                      eventId={eventId}
                      canAccess={canParticipate && problem.isUnlocked}
                    />
                  ))
                )}
              </CardContent>
            </Card>

            {/* Team Info (if team event) */}
            {event.participantType === 'team' && event.teamInfo && (
              <Card>
                <CardHeader>
                  <h2 className="text-xl font-semibold">チーム情報</h2>
                </CardHeader>
                <CardContent>
                  <div className="space-y-4">
                    <div>
                      <h3 className="font-medium text-gray-900">
                        {event.teamInfo.name}
                      </h3>
                      <p className="text-sm text-gray-500">
                        メンバー: {event.teamInfo.members.length}人
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {event.teamInfo.members.map((member) => (
                        <span
                          key={member.id}
                          className="px-3 py-1 bg-gray-100 rounded-full text-sm"
                        >
                          {member.name}
                          {member.role === 'captain' && ' 👑'}
                        </span>
                      ))}
                    </div>
                    {event.teamInfo.inviteCode && (
                      <div className="p-3 bg-gray-50 rounded-lg">
                        <p className="text-sm text-gray-600">招待コード</p>
                        <code className="text-lg font-mono">
                          {event.teamInfo.inviteCode}
                        </code>
                      </div>
                    )}
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
                  {event.myRank && (
                    <div className="mb-4">
                      <div className="text-4xl font-bold text-blue-600">
                        #{event.myRank}
                      </div>
                      <div className="text-gray-500">{event.myScore} pts</div>
                    </div>
                  )}

                  {!event.isRegistered && event.status !== 'completed' && (
                    <Button
                      onClick={handleRegister}
                      loading={registering}
                      fullWidth
                      size="lg"
                    >
                      {event.participantType === 'team'
                        ? 'チームで登録'
                        : '参加登録'}
                    </Button>
                  )}

                  {canParticipate && (
                    <Link href={`/events/${eventId}/play`}>
                      <Button fullWidth size="lg">
                        バトルに参加 ⚔️
                      </Button>
                    </Link>
                  )}

                  {event.isRegistered && !isActive && (
                    <p className="text-gray-600">
                      イベント開始をお待ちください
                    </p>
                  )}
                </div>

                <div className="border-t pt-4 space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-500">参加者数</span>
                    <span className="font-medium">
                      {event.participantCount}人
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">参加形式</span>
                    <span className="font-medium">
                      {event.participantType === 'team' ? 'チーム' : '個人'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">クラウド</span>
                    <span className="font-medium">
                      {event.cloudProvider.toUpperCase()}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">採点方式</span>
                    <span className="font-medium">
                      {event.scoringType === 'realtime'
                        ? 'リアルタイム'
                        : 'バッチ'}
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Leaderboard Preview */}
            {leaderboard && event.leaderboardVisible && (
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <h2 className="font-semibold">リーダーボード</h2>
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
                          entry.isMe ? 'bg-blue-50' : ''
                        }`}
                      >
                        <div className="flex items-center gap-3">
                          <span
                            className={`font-bold ${
                              entry.rank === 1
                                ? 'text-yellow-500'
                                : entry.rank === 2
                                  ? 'text-gray-400'
                                  : entry.rank === 3
                                    ? 'text-amber-600'
                                    : 'text-gray-500'
                            }`}
                          >
                            #{entry.rank}
                          </span>
                          <span className={entry.isMe ? 'font-medium' : ''}>
                            {entry.name}
                            {entry.isMe && ' (自分)'}
                          </span>
                        </div>
                        <span className="font-medium">{entry.totalScore}</span>
                      </div>
                    ))}
                  </div>
                </CardContent>
                <CardFooter>
                  <Link
                    href={`/events/${eventId}/leaderboard`}
                    className="text-blue-600 hover:text-blue-700 text-sm font-medium"
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

// Problem Card Component
function ProblemCard({
  problem,
  eventId,
  canAccess,
}: {
  problem: ChallengeProblem;
  eventId: string;
  canAccess: boolean;
}) {
  return (
    <div
      className={`p-4 border rounded-lg ${
        canAccess ? 'hover:border-blue-300 cursor-pointer' : 'opacity-75'
      } ${problem.isCompleted ? 'bg-green-50 border-green-200' : 'bg-white'}`}
    >
      <Link
        href={canAccess ? `/events/${eventId}/challenges/${problem.id}` : '#'}
        className={canAccess ? '' : 'pointer-events-none'}
      >
        <div className="flex items-start justify-between">
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-gray-400 font-medium">
                #{problem.order}
              </span>
              <DifficultyBadge difficulty={problem.difficulty} />
              {!problem.isUnlocked && (
                <Badge variant="default" size="sm">
                  🔒 ロック中
                </Badge>
              )}
              {problem.isCompleted && (
                <Badge variant="success" size="sm">
                  ✓ 完了
                </Badge>
              )}
            </div>
            <h3 className="font-semibold text-gray-900">{problem.title}</h3>
            <p className="text-sm text-gray-600 mt-1 line-clamp-2">
              {problem.overview}
            </p>
          </div>
          <div className="text-right ml-4">
            <div className="text-lg font-bold text-blue-600">
              {problem.maxScore * problem.pointMultiplier}
            </div>
            <div className="text-xs text-gray-500">pts</div>
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
