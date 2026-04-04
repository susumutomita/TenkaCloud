/**
 * Event Detail Page
 *
 * Cloudscape Design System — イベント詳細ページ
 */

'use client';

import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Cards from '@cloudscape-design/components/cards';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Input from '@cloudscape-design/components/input';
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs';
import CloudscapeLink from '@cloudscape-design/components/link';
import Modal from '@cloudscape-design/components/modal';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import Tabs from '@cloudscape-design/components/tabs';
import '@cloudscape-design/global-styles/index.css';
import NextLink from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Header as AppHeader } from '../../../components/layout';
import {
  getEventDetails,
  getLeaderboard,
  registerForEvent,
} from '../../../lib/api/events';
import type {
  ChallengeProblem,
  EventDetails,
  EventStatus,
  Leaderboard,
} from '../../../lib/api/types';

function getEventStatusIndicator(status: EventStatus) {
  switch (status) {
    case 'active':
      return <StatusIndicator type="success">開催中</StatusIndicator>;
    case 'scheduled':
      return <StatusIndicator type="pending">開催予定</StatusIndicator>;
    case 'completed':
      return <StatusIndicator type="stopped">終了</StatusIndicator>;
    case 'cancelled':
      return <StatusIndicator type="error">キャンセル</StatusIndicator>;
    case 'paused':
      return <StatusIndicator type="warning">一時停止</StatusIndicator>;
    default:
      return <StatusIndicator type="info">{status}</StatusIndicator>;
  }
}

function getDifficultyBadge(difficulty: ChallengeProblem['difficulty']) {
  const colorMap: Record<string, 'red' | 'blue' | 'green' | 'grey'> = {
    easy: 'green',
    medium: 'blue',
    hard: 'red',
    expert: 'red',
  };
  const labelMap: Record<string, string> = {
    easy: '初級',
    medium: '中級',
    hard: '上級',
    expert: 'エキスパート',
  };
  return (
    <Badge color={colorMap[difficulty] ?? 'grey'}>
      {labelMap[difficulty] ?? difficulty}
    </Badge>
  );
}

function getProblemStatusIndicator(problem: ChallengeProblem) {
  if (problem.isCompleted)
    return <StatusIndicator type="success">完了</StatusIndicator>;
  if (problem.isUnlocked)
    return <StatusIndicator type="in-progress">進行中</StatusIndicator>;
  return <StatusIndicator type="stopped">ロック中</StatusIndicator>;
}

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

export default function EventDetailPage() {
  const params = useParams();
  const router = useRouter();
  const eventId = params.eventId as string;

  const [event, setEvent] = useState<EventDetails | null>(null);
  const [leaderboard, setLeaderboard] = useState<Leaderboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [registering, setRegistering] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Registration modal state
  const [showModal, setShowModal] = useState(false);
  const [activeTab, setActiveTab] = useState('solo');
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

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
      await fetch('/api/gameday/teams/solo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId }),
      });
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

  if (loading) {
    return (
      <div className="min-h-screen bg-surface-0">
        <AppHeader />
        <div className="flex justify-center items-center h-64">
          <Spinner size="large" />
        </div>
      </div>
    );
  }

  if (error || !event) {
    return (
      <div className="min-h-screen bg-surface-0">
        <AppHeader />
        <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="awsui-dark-mode">
            <Container>
              <Box textAlign="center" padding="xl">
                <SpaceBetween size="m">
                  <StatusIndicator type="error">
                    {error || 'イベントが見つかりません'}
                  </StatusIndicator>
                  <Button onClick={() => router.push('/events')}>
                    イベント一覧に戻る
                  </Button>
                </SpaceBetween>
              </Box>
            </Container>
          </div>
        </main>
      </div>
    );
  }

  const isActive = event.status === 'active';
  const canParticipate = event.isRegistered && isActive;

  return (
    <div className="min-h-screen bg-surface-0">
      <AppHeader />

      {/* Registration Modal */}
      <div className="awsui-dark-mode">
        <Modal
          visible={showModal}
          onDismiss={() => setShowModal(false)}
          closeAriaLabel="閉じる"
          header="参加登録"
          size="medium"
          footer={
            <Box float="right">
              <Button variant="link" onClick={() => setShowModal(false)}>
                キャンセル
              </Button>
            </Box>
          }
        >
          <SpaceBetween size="l">
            <Box variant="p" color="text-body-secondary">
              参加方法を選択してください
            </Box>

            <Tabs
              activeTabId={activeTab}
              onChange={({ detail }) => {
                setActiveTab(detail.activeTabId);
                setModalError(null);
              }}
              tabs={[
                {
                  id: 'solo',
                  label: '一人で参加',
                  content: (
                    <SpaceBetween size="m">
                      <Box variant="p">個人として参加します。</Box>
                      <Button
                        variant="primary"
                        fullWidth
                        onClick={() => void handleSoloRegister()}
                        loading={registering}
                      >
                        一人で参加する
                      </Button>
                    </SpaceBetween>
                  ),
                },
                {
                  id: 'create',
                  label: 'チームを作成',
                  content: (
                    <SpaceBetween size="m">
                      <FormField label="チーム名">
                        <Input
                          value={teamName}
                          onChange={({ detail }) => setTeamName(detail.value)}
                          placeholder="チーム名を入力"
                        />
                      </FormField>
                      <Button
                        variant="primary"
                        fullWidth
                        onClick={() => void handleCreateTeam()}
                        loading={registering}
                      >
                        チームを作成して参加
                      </Button>
                    </SpaceBetween>
                  ),
                },
                {
                  id: 'join',
                  label: '招待コードで参加',
                  content: (
                    <SpaceBetween size="m">
                      <FormField label="招待コード">
                        <Input
                          value={inviteCode}
                          onChange={({ detail }) =>
                            setInviteCode(detail.value.toUpperCase())
                          }
                          placeholder="6文字のコードを入力"
                        />
                      </FormField>
                      <Button
                        variant="primary"
                        fullWidth
                        onClick={() => void handleJoinTeam()}
                        loading={registering}
                      >
                        チームに参加
                      </Button>
                    </SpaceBetween>
                  ),
                },
              ]}
            />

            {modalError && (
              <StatusIndicator type="error">{modalError}</StatusIndicator>
            )}
          </SpaceBetween>
        </Modal>
      </div>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="awsui-dark-mode">
          <SpaceBetween size="l">
            {/* Breadcrumb */}
            <CloudscapeLink
              href="/events"
              onFollow={(e) => {
                e.preventDefault();
                router.push('/events');
              }}
            >
              &larr; イベント一覧
            </CloudscapeLink>

            {/* Event Header Container */}
            <Container
              header={
                <Header
                  variant="h1"
                  description={
                    <span
                      style={{
                        display: 'inline-flex',
                        gap: '6px',
                        alignItems: 'center',
                      }}
                    >
                      {getEventStatusIndicator(event.status)}
                      <Badge
                        color={event.type === 'gameday' ? 'blue' : 'green'}
                      >
                        {event.type === 'gameday' ? 'GameDay' : 'JAM'}
                      </Badge>
                      {event.isRegistered && (
                        <Badge color="green">登録済み</Badge>
                      )}
                    </span>
                  }
                  actions={
                    <SpaceBetween direction="horizontal" size="xs">
                      {!event.isRegistered && event.status !== 'completed' && (
                        <Button
                          variant="primary"
                          onClick={handleRegisterClick}
                          loading={registering}
                        >
                          {event.participantType === 'team'
                            ? 'チームで登録'
                            : '参加登録'}
                        </Button>
                      )}
                      {canParticipate && (
                        <NextLink href={`/gameday/${eventId}`}>
                          <Button variant="primary">バトルに参加</Button>
                        </NextLink>
                      )}
                    </SpaceBetween>
                  }
                >
                  {event.name}
                </Header>
              }
            >
              <KeyValuePairs
                columns={4}
                items={[
                  {
                    label: '開始',
                    value: formatDate(event.startTime),
                  },
                  {
                    label: '終了',
                    value: formatDate(event.endTime),
                  },
                  {
                    label: '期間',
                    value: getEventDuration(event.startTime, event.endTime),
                  },
                  {
                    label: '参加者数',
                    value: `${event.participantCount}人`,
                  },
                  {
                    label: '参加形式',
                    value: event.participantType === 'team' ? 'チーム' : '個人',
                  },
                  {
                    label: 'クラウド',
                    value: event.cloudProvider.toUpperCase(),
                  },
                  {
                    label: '採点方式',
                    value:
                      event.scoringType === 'realtime'
                        ? 'リアルタイム'
                        : 'バッチ',
                  },
                  ...(event.myRank
                    ? [
                        {
                          label: 'あなたの順位',
                          value: (
                            <Box fontSize="heading-l" fontWeight="bold">
                              #{event.myRank}
                              <Box
                                variant="span"
                                fontSize="body-s"
                                color="text-body-secondary"
                              >
                                {' '}
                                ({event.myScore} pts)
                              </Box>
                            </Box>
                          ),
                        },
                      ]
                    : []),
                ]}
              />
            </Container>

            <ColumnLayout
              columns={
                event.participantType === 'team' && event.teamInfo ? 2 : 1
              }
            >
              {/* Problems List */}
              <Cards
                ariaLabels={{
                  itemSelectionLabel: (_e, n) => `選択: ${n.title}`,
                  selectionGroupLabel: '問題選択',
                }}
                cardDefinition={{
                  header: (problem) => (
                    <SpaceBetween direction="horizontal" size="xs">
                      <CloudscapeLink
                        href={
                          canParticipate && problem.isUnlocked
                            ? `/events/${eventId}/challenges/${problem.id}`
                            : undefined
                        }
                        onFollow={(e) => {
                          if (canParticipate && problem.isUnlocked) {
                            e.preventDefault();
                            router.push(
                              `/events/${eventId}/challenges/${problem.id}`
                            );
                          }
                        }}
                        fontSize="heading-m"
                      >
                        {problem.title}
                      </CloudscapeLink>
                    </SpaceBetween>
                  ),
                  sections: [
                    {
                      id: 'meta',
                      content: (problem) => (
                        <SpaceBetween direction="horizontal" size="xs">
                          {getDifficultyBadge(problem.difficulty)}
                          {getProblemStatusIndicator(problem)}
                          <Box variant="small">
                            {problem.maxScore * problem.pointMultiplier} pts
                          </Box>
                        </SpaceBetween>
                      ),
                    },
                    {
                      id: 'overview',
                      header: '概要',
                      content: (problem) => (
                        <Box variant="p" color="text-body-secondary">
                          {problem.overview}
                        </Box>
                      ),
                    },
                  ],
                }}
                cardsPerRow={[{ cards: 1 }, { minWidth: 500, cards: 2 }]}
                items={event.problems}
                loadingText="問題を読み込み中"
                header={
                  <Header counter={`(${event.problemCount})`}>問題一覧</Header>
                }
                empty={
                  <Box textAlign="center" padding="l">
                    {isActive
                      ? 'まだ問題が登録されていません'
                      : '問題はイベント開始時に公開されます'}
                  </Box>
                }
              />

              {/* Team Info (if team event) */}
              {event.participantType === 'team' && event.teamInfo && (
                <Container header={<Header variant="h2">チーム情報</Header>}>
                  <SpaceBetween size="l">
                    <KeyValuePairs
                      columns={2}
                      items={[
                        {
                          label: 'チーム名',
                          value: (
                            <Box fontWeight="bold">{event.teamInfo.name}</Box>
                          ),
                        },
                        {
                          label: 'メンバー数',
                          value: `${event.teamInfo.members.length}人`,
                        },
                      ]}
                    />

                    <Box variant="h3">メンバー</Box>
                    <SpaceBetween direction="horizontal" size="xs">
                      {event.teamInfo.members.map((member) => (
                        <Badge
                          key={member.id}
                          color={member.role === 'captain' ? 'blue' : 'grey'}
                        >
                          {member.name}
                          {member.role === 'captain' && ' (キャプテン)'}
                        </Badge>
                      ))}
                    </SpaceBetween>

                    {event.teamInfo.inviteCode && (
                      <Container
                        header={<Header variant="h3">招待コード</Header>}
                      >
                        <Box
                          fontSize="heading-l"
                          fontWeight="bold"
                          variant="code"
                        >
                          {event.teamInfo.inviteCode}
                        </Box>
                      </Container>
                    )}
                  </SpaceBetween>
                </Container>
              )}
            </ColumnLayout>

            {/* Leaderboard Preview */}
            {leaderboard && event.leaderboardVisible && (
              <Table
                columnDefinitions={[
                  {
                    id: 'rank',
                    header: '順位',
                    cell: (entry) => (
                      <Box fontWeight={entry.rank <= 3 ? 'bold' : 'normal'}>
                        #{entry.rank}
                      </Box>
                    ),
                    width: 80,
                  },
                  {
                    id: 'name',
                    header: '名前',
                    cell: (entry) => (
                      <SpaceBetween direction="horizontal" size="xs">
                        <span>{entry.name}</span>
                        {entry.isMe && <Badge color="blue">自分</Badge>}
                      </SpaceBetween>
                    ),
                  },
                  {
                    id: 'score',
                    header: 'スコア',
                    cell: (entry) => (
                      <Box fontWeight="bold">{entry.totalScore}</Box>
                    ),
                    width: 120,
                  },
                ]}
                items={leaderboard.entries.slice(0, 5)}
                loadingText="読み込み中"
                header={
                  <Header
                    actions={
                      <NextLink href={`/events/${eventId}/leaderboard`}>
                        <Button variant="link">全ランキングを見る</Button>
                      </NextLink>
                    }
                    description={
                      leaderboard.isFrozen ? (
                        <StatusIndicator type="warning">凍結中</StatusIndicator>
                      ) : undefined
                    }
                  >
                    リーダーボード
                  </Header>
                }
                empty="リーダーボードデータはありません"
              />
            )}

            {/* Waiting message for registered but not active */}
            {event.isRegistered && !isActive && (
              <Container>
                <Box textAlign="center" padding="l">
                  <StatusIndicator type="pending">
                    イベント開始をお待ちください
                  </StatusIndicator>
                </Box>
              </Container>
            )}
          </SpaceBetween>
        </div>
      </main>
    </div>
  );
}
