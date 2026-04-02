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

type RegistrationMode = 'solo' | 'create' | 'join';

interface LocalGamedayData {
  teamId: string;
  teamName: string;
  mode: 'solo' | 'team';
}

export default function EventDetailPage() {
  const params = useParams();
  const router = useRouter();
  const eventId = params.eventId as string;

  const [event, setEvent] = useState<EventDetails | null>(null);
  const [leaderboard, setLeaderboard] = useState<Leaderboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [registering, setRegistering] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Modal state
  const [showModal, setShowModal] = useState(false);
  const [activeTab, setActiveTab] = useState<RegistrationMode>('solo');
  const [teamName, setTeamName] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [modalError, setModalError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchData() {
      try {
        setLoading(true);
        const [eventResult, leaderboardResult] = await Promise.allSettled([
          getEventDetails(eventId),
          getLeaderboard(eventId),
        ]);
        const eventData =
          eventResult.status === 'fulfilled' ? eventResult.value : null;
        const leaderboardData =
          leaderboardResult.status === 'fulfilled'
            ? leaderboardResult.value
            : null;

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

  const saveLocalGamedayData = (data: LocalGamedayData) => {
    if (typeof window !== 'undefined') {
      localStorage.setItem(
        `tenkacloud_gameday_${eventId}`,
        JSON.stringify(data)
      );
    }
  };

  const refreshEvent = async () => {
    const updatedEvent = await getEventDetails(eventId);
    if (updatedEvent) setEvent(updatedEvent);
  };

  const handleRegisterClick = () => {
    if (!event) return;
    if (event.participantType === 'team') {
      setModalError(null);
      setTeamName('');
      setInviteCode('');
      setActiveTab('solo');
      setShowModal(true);
    } else {
      void handleSoloRegister();
    }
  };

  const handleSoloRegister = async () => {
    try {
      setRegistering(true);
      await registerForEvent(eventId);
      const soloId = `solo-dev-user`;
      saveLocalGamedayData({ teamId: soloId, teamName: '', mode: 'solo' });
      await refreshEvent();
      setShowModal(false);
    } catch (err) {
      setModalError(err instanceof Error ? err.message : '登録に失敗しました');
    } finally {
      setRegistering(false);
    }
  };

  const handleCreateTeam = async () => {
    if (!teamName.trim()) {
      setModalError('チーム名を入力してください');
      return;
    }
    try {
      setRegistering(true);
      setModalError(null);
      const newTeamId = crypto.randomUUID().replace(/-/g, '').toUpperCase();
      const res = await fetch('/api/gameday/teams/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId, teamId: newTeamId, teamName }),
      });
      const data = (await res.json()) as {
        teamId?: string;
        teamName?: string;
        inviteCode?: string;
        error?: string;
      };
      if (!res.ok) {
        setModalError(data.error ?? 'チーム作成に失敗しました');
        return;
      }
      await registerForEvent(eventId);
      saveLocalGamedayData({
        teamId: data.teamId ?? newTeamId,
        teamName: data.teamName ?? teamName,
        mode: 'team',
      });
      await refreshEvent();
      setShowModal(false);
    } catch (err) {
      setModalError(
        err instanceof Error ? err.message : 'チーム作成に失敗しました'
      );
    } finally {
      setRegistering(false);
    }
  };

  const handleJoinTeam = async () => {
    if (!inviteCode.trim()) {
      setModalError('招待コードを入力してください');
      return;
    }
    try {
      setRegistering(true);
      setModalError(null);
      const res = await fetch('/api/gameday/teams/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId, inviteCode: inviteCode.toUpperCase() }),
      });
      const data = (await res.json()) as {
        teamId?: string;
        teamName?: string;
        error?: string;
      };
      if (!res.ok) {
        setModalError(data.error ?? '招待コードが無効です');
        return;
      }
      await registerForEvent(eventId);
      saveLocalGamedayData({
        teamId: data.teamId ?? '',
        teamName: data.teamName ?? '',
        mode: 'team',
      });
      await refreshEvent();
      setShowModal(false);
    } catch (err) {
      setModalError(
        err instanceof Error ? err.message : 'チーム参加に失敗しました'
      );
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
      <div className="min-h-screen bg-surface-0">
        <Header />
        <div className="flex justify-center items-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-hn-accent" />
        </div>
      </div>
    );
  }

  if (error || !event) {
    return (
      <div className="min-h-screen bg-surface-0">
        <Header />
        <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <Card className="p-8 text-center">
            <p className="text-hn-error mb-4">
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
    <div className="min-h-screen bg-surface-0 relative overflow-hidden">
      {/* Background decoration */}
      <div className="absolute top-0 left-0 w-full h-full overflow-hidden -z-10 pointer-events-none">
        <div className="absolute top-[-10%] right-[-5%] w-[500px] h-[500px] bg-hn-accent/10 rounded-full blur-[100px]" />
        <div className="absolute bottom-[-10%] left-[-5%] w-[500px] h-[500px] bg-hn-purple/10 rounded-full blur-[100px]" />
      </div>

      <Header />

      {/* Registration Modal */}
      {showModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setShowModal(false)}
        >
          <div
            className="bg-surface-1 border border-border rounded-xl w-full max-w-md mx-4 p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-xl font-bold text-text-primary mb-2">
              参加登録
            </h2>
            <p className="text-text-muted text-sm mb-5">
              参加方法を選択してください
            </p>

            {/* Tabs */}
            <div className="flex gap-1 mb-5 bg-surface-0 rounded-lg p-1">
              {(['solo', 'create', 'join'] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => {
                    setActiveTab(tab);
                    setModalError(null);
                  }}
                  className={`flex-1 py-2 px-3 rounded-md text-sm font-medium transition-colors ${
                    activeTab === tab
                      ? 'bg-surface-2 text-text-primary'
                      : 'text-text-muted hover:text-text-secondary'
                  }`}
                >
                  {tab === 'solo' && '一人で参加'}
                  {tab === 'create' && 'チームを作成'}
                  {tab === 'join' && '招待コードで参加'}
                </button>
              ))}
            </div>

            {/* Tab Content */}
            <div className="space-y-4">
              {activeTab === 'solo' && (
                <div>
                  <p className="text-text-secondary text-sm mb-4">
                    個人として参加します。
                  </p>
                  <Button
                    fullWidth
                    onClick={() => void handleSoloRegister()}
                    loading={registering}
                  >
                    一人で参加する
                  </Button>
                </div>
              )}

              {activeTab === 'create' && (
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-text-secondary mb-1">
                      チーム名
                    </label>
                    <input
                      type="text"
                      value={teamName}
                      onChange={(e) => setTeamName(e.target.value)}
                      placeholder="チーム名を入力"
                      className="w-full px-3 py-2 bg-surface-0 border border-border rounded-lg text-text-primary placeholder:text-text-muted focus:outline-none focus:border-hn-accent"
                    />
                  </div>
                  <Button
                    fullWidth
                    onClick={() => void handleCreateTeam()}
                    loading={registering}
                  >
                    チームを作成して参加
                  </Button>
                </div>
              )}

              {activeTab === 'join' && (
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-text-secondary mb-1">
                      招待コード
                    </label>
                    <input
                      type="text"
                      value={inviteCode}
                      onChange={(e) =>
                        setInviteCode(e.target.value.toUpperCase())
                      }
                      placeholder="6文字のコードを入力"
                      maxLength={6}
                      className="w-full px-3 py-2 bg-surface-0 border border-border rounded-lg text-text-primary placeholder:text-text-muted font-mono tracking-widest focus:outline-none focus:border-hn-accent"
                    />
                  </div>
                  <Button
                    fullWidth
                    onClick={() => void handleJoinTeam()}
                    loading={registering}
                  >
                    チームに参加
                  </Button>
                </div>
              )}

              {modalError && (
                <p className="text-hn-error text-sm">{modalError}</p>
              )}
            </div>

            <button
              type="button"
              onClick={() => setShowModal(false)}
              className="mt-5 w-full text-center text-text-muted hover:text-text-secondary text-sm"
            >
              キャンセル
            </button>
          </div>
        </div>
      )}

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Breadcrumb */}
        <nav className="mb-6">
          <Link
            href="/events"
            className="text-hn-accent hover:text-hn-accent-bright"
          >
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
          <h1 className="text-3xl font-bold text-text-primary mb-4">
            {event.name}
          </h1>
          <div className="flex flex-wrap gap-6 text-text-secondary">
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
                <h2 className="text-xl font-semibold text-text-primary">
                  問題一覧 ({event.problemCount}問)
                </h2>
              </CardHeader>
              <CardContent className="space-y-4">
                {event.problems.length === 0 ? (
                  <p className="text-text-muted text-center py-8">
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
                  <h2 className="text-xl font-semibold text-text-primary">
                    チーム情報
                  </h2>
                </CardHeader>
                <CardContent>
                  <div className="space-y-4">
                    <div>
                      <h3 className="font-medium text-text-primary">
                        {event.teamInfo.name}
                      </h3>
                      <p className="text-sm text-text-muted">
                        メンバー: {event.teamInfo.members.length}人
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {event.teamInfo.members.map((member) => (
                        <span
                          key={member.id}
                          className="px-3 py-1 bg-surface-3 rounded-full text-sm text-text-secondary"
                        >
                          {member.name}
                          {member.role === 'captain' && ' 👑'}
                        </span>
                      ))}
                    </div>
                    {event.teamInfo.inviteCode && (
                      <div className="p-3 bg-surface-0 rounded-lg border border-border">
                        <p className="text-sm text-text-muted">招待コード</p>
                        <code className="text-lg font-mono text-hn-accent">
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
                      <div className="text-4xl font-bold text-hn-accent">
                        #{event.myRank}
                      </div>
                      <div className="text-text-muted">{event.myScore} pts</div>
                    </div>
                  )}

                  {!event.isRegistered && event.status !== 'completed' && (
                    <Button
                      onClick={handleRegisterClick}
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
                    <Link href={`/gameday/${eventId}`}>
                      <Button fullWidth size="lg">
                        バトルに参加 ⚔️
                      </Button>
                    </Link>
                  )}

                  {event.isRegistered && !isActive && (
                    <p className="text-text-muted">
                      イベント開始をお待ちください
                    </p>
                  )}
                </div>

                <div className="border-t border-border pt-4 space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-text-muted">参加者数</span>
                    <span className="font-medium text-text-primary">
                      {event.participantCount}人
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-text-muted">参加形式</span>
                    <span className="font-medium text-text-primary">
                      {event.participantType === 'team' ? 'チーム' : '個人'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-text-muted">クラウド</span>
                    <span className="font-medium text-text-primary">
                      {event.cloudProvider.toUpperCase()}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-text-muted">採点方式</span>
                    <span className="font-medium text-text-primary">
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
                                  ? 'text-text-secondary'
                                  : entry.rank === 3
                                    ? 'text-hn-warning/70'
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
                    href={`/events/${eventId}/leaderboard`}
                    className="text-hn-accent hover:text-hn-accent-bright text-sm font-medium"
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
      className={`p-4 border rounded-lg transition-colors ${
        canAccess
          ? 'hover:border-hn-accent cursor-pointer border-border'
          : 'opacity-75 border-border'
      } ${problem.isCompleted ? 'bg-hn-success/10 border-hn-success/30' : 'bg-surface-2'}`}
    >
      <Link
        href={canAccess ? `/events/${eventId}/challenges/${problem.id}` : '#'}
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
                  🔒 ロック中
                </Badge>
              )}
              {problem.isCompleted && (
                <Badge variant="success" size="sm">
                  ✓ 完了
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
