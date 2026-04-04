/**
 * Battle Detail Page
 *
 * Cloudscape Design System — バトル詳細ページ
 */

'use client';

import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import BreadcrumbGroup from '@cloudscape-design/components/breadcrumb-group';
import Button from '@cloudscape-design/components/button';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs';
import Link from '@cloudscape-design/components/link';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import '@cloudscape-design/global-styles/index.css';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Header as AppHeader } from '@/components/layout';
import { useI18n } from '@/lib/i18n';
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
  return date.toLocaleDateString(undefined, {
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
    ? `${hours}h${minutes > 0 ? ` ${minutes}m` : ''}`
    : `${minutes}m`;
}

export default function BattleDetailPage() {
  const params = useParams();
  const router = useRouter();
  const { t } = useI18n();
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
        setError(err instanceof Error ? err.message : t('common.loading'));
      } finally {
        setLoading(false);
      }
    }

    fetchData();
    // router is stable in Next.js production; excluding it prevents infinite re-renders in tests
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [battleId]);

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
      setError(err instanceof Error ? err.message : t('common.loading'));
    } finally {
      setRegistering(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-surface-0">
        <AppHeader />
        <Box textAlign="center" padding="xl">
          <Spinner size="large" />
        </Box>
      </div>
    );
  }

  if (error || !battle) {
    return (
      <div className="min-h-screen bg-surface-0">
        <AppHeader />
        <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="awsui-dark-mode">
            <Container>
              <SpaceBetween size="m">
                <StatusIndicator type="error">
                  {error || t('battles.notFound')}
                </StatusIndicator>
                <Button onClick={() => router.push('/battles')}>
                  {t('battles.backToList')}
                </Button>
              </SpaceBetween>
            </Container>
          </div>
        </main>
      </div>
    );
  }

  const isActive = battle.status === 'active';
  const canParticipate = battle.isRegistered && isActive;

  return (
    <div className="min-h-screen bg-surface-0">
      <AppHeader />

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="awsui-dark-mode">
          <SpaceBetween size="l">
            <BreadcrumbGroup
              items={[
                { text: t('battles.title'), href: '/battles' },
                { text: battle.name, href: '#' },
              ]}
              onFollow={(e) => {
                e.preventDefault();
                if (e.detail.href !== '#') router.push(e.detail.href);
              }}
            />

            <Header
              variant="h1"
              description={`${t('events.startTime')}: ${formatDate(battle.startTime)} — ${t('events.endTime')}: ${formatDate(battle.endTime)} (${getEventDuration(battle.startTime, battle.endTime)})`}
              actions={
                <SpaceBetween direction="horizontal" size="xs">
                  {battle.isRegistered && (
                    <Badge color="green">{t('events.registered')}</Badge>
                  )}
                  {!battle.isRegistered && battle.status !== 'completed' && (
                    <Button
                      variant="primary"
                      onClick={handleRegister}
                      loading={registering}
                    >
                      {battle.participantType === 'team'
                        ? t('battles.teamRegister')
                        : t('battles.register')}
                    </Button>
                  )}
                  {canParticipate && (
                    <Button
                      variant="primary"
                      onClick={() =>
                        router.push(`/battles/${battleId}/problems`)
                      }
                    >
                      {t('battles.challengeProblems')}
                    </Button>
                  )}
                </SpaceBetween>
              }
            >
              {battle.name}
            </Header>

            <ColumnLayout columns={2} variant="text-grid">
              {/* Problems */}
              {isActive && (
                <Container
                  header={
                    <Header
                      variant="h2"
                      counter={`(${battle.problemCount})`}
                      actions={
                        canParticipate ? (
                          <Button
                            variant="link"
                            onClick={() =>
                              router.push(`/battles/${battleId}/problems`)
                            }
                          >
                            {t('battles.viewAll')}
                          </Button>
                        ) : undefined
                      }
                    >
                      {t('battles.problemsList')}
                    </Header>
                  }
                >
                  {battle.problems.length === 0 ? (
                    <Box
                      color="text-body-secondary"
                      textAlign="center"
                      padding="l"
                    >
                      {t('battles.problemsWillOpen')}
                    </Box>
                  ) : (
                    <Table
                      columnDefinitions={[
                        {
                          id: 'order',
                          header: '#',
                          cell: (p) => p.order,
                          width: 50,
                        },
                        {
                          id: 'title',
                          header: t('battles.problemsList'),
                          cell: (p: ChallengeProblem) => (
                            <SpaceBetween direction="horizontal" size="xs">
                              {canParticipate && p.isUnlocked ? (
                                <Link
                                  href={`/battles/${battleId}/problems/${p.id}`}
                                  onFollow={(e) => {
                                    e.preventDefault();
                                    router.push(
                                      `/battles/${battleId}/problems/${p.id}`,
                                    );
                                  }}
                                >
                                  {p.title}
                                </Link>
                              ) : (
                                <Box variant="span">{p.title}</Box>
                              )}
                              {!p.isUnlocked && (
                                <Badge color="grey">
                                  {t('battles.locked')}
                                </Badge>
                              )}
                              {p.isCompleted && (
                                <Badge color="green">
                                  {t('battles.completedBadge')}
                                </Badge>
                              )}
                            </SpaceBetween>
                          ),
                        },
                        {
                          id: 'score',
                          header: 'pts',
                          cell: (p) => p.maxScore * p.pointMultiplier,
                          width: 80,
                        },
                      ]}
                      items={battle.problems}
                      variant="embedded"
                    />
                  )}
                </Container>
              )}

              {/* Team Info */}
              {battle.participantType === 'team' && battle.teamInfo && (
                <Container
                  header={<Header variant="h2">{t('battles.teamInfo')}</Header>}
                >
                  <SpaceBetween size="m">
                    <Box fontWeight="bold">{battle.teamInfo.name}</Box>
                    <Box variant="small">
                      {t('battles.members')}: {battle.teamInfo.members.length}
                    </Box>
                    <SpaceBetween direction="horizontal" size="xs">
                      {battle.teamInfo.members.map((member) => (
                        <Badge key={member.id} color="blue">
                          {member.name}
                          {member.role === 'captain' ? ' ★' : ''}
                        </Badge>
                      ))}
                    </SpaceBetween>
                  </SpaceBetween>
                </Container>
              )}

              {/* Info sidebar */}
              <Container header={<Header variant="h2">{battle.name}</Header>}>
                <SpaceBetween size="m">
                  {battle.myRank && (
                    <Box textAlign="center">
                      <Box
                        fontSize="display-l"
                        fontWeight="bold"
                        color="text-status-info"
                      >
                        #{battle.myRank}
                      </Box>
                      <Box variant="small">{battle.myScore} pts</Box>
                    </Box>
                  )}

                  {battle.isRegistered && !isActive && (
                    <StatusIndicator type="pending">
                      {t('battles.waitForStart')}
                    </StatusIndicator>
                  )}

                  <KeyValuePairs
                    columns={1}
                    items={[
                      {
                        label: t('battles.participantCount'),
                        value: String(battle.participantCount),
                      },
                      {
                        label: t('battles.participantFormat'),
                        value:
                          battle.participantType === 'team'
                            ? t('events.team')
                            : t('events.solo'),
                      },
                      {
                        label: t('battles.cloud'),
                        value: battle.cloudProvider.toUpperCase(),
                      },
                      {
                        label: t('battles.scoringType'),
                        value:
                          battle.scoringType === 'realtime'
                            ? t('battles.realtime')
                            : t('battles.batch'),
                      },
                    ]}
                  />

                  {battle.isRegistered && (
                    <SpaceBetween size="xs">
                      <Button
                        fullWidth
                        onClick={() =>
                          router.push(`/battles/${battleId}/scores`)
                        }
                      >
                        {t('battles.viewScores')}
                      </Button>
                      <Button
                        fullWidth
                        onClick={() =>
                          router.push(`/battles/${battleId}/leaderboard`)
                        }
                      >
                        {t('battles.viewLeaderboard')}
                      </Button>
                    </SpaceBetween>
                  )}
                </SpaceBetween>
              </Container>

              {/* Leaderboard preview */}
              {leaderboard && battle.leaderboardVisible && (
                <Container
                  header={
                    <Header
                      variant="h2"
                      actions={
                        leaderboard.isFrozen ? (
                          <Badge color="severity-medium">
                            {t('battles.frozen')}
                          </Badge>
                        ) : undefined
                      }
                    >
                      {t('battles.viewLeaderboard')}
                    </Header>
                  }
                >
                  <SpaceBetween size="xs">
                    {leaderboard.entries.slice(0, 5).map((entry) => (
                      <Box
                        key={entry.teamId || entry.participantId}
                        padding="s"
                      >
                        <SpaceBetween direction="horizontal" size="xs">
                          <Box fontWeight="bold" color="text-status-info">
                            #{entry.rank}
                          </Box>
                          <Box variant="span">
                            {entry.name}
                            {entry.isMe && (
                              <Badge color="blue"> {t('battles.me')}</Badge>
                            )}
                          </Box>
                          <Box variant="span" fontWeight="bold">
                            {entry.totalScore}
                          </Box>
                        </SpaceBetween>
                      </Box>
                    ))}
                    <Link
                      href={`/battles/${battleId}/leaderboard`}
                      onFollow={(e) => {
                        e.preventDefault();
                        router.push(`/battles/${battleId}/leaderboard`);
                      }}
                    >
                      {t('battles.fullLeaderboard')}
                    </Link>
                  </SpaceBetween>
                </Container>
              )}
            </ColumnLayout>
          </SpaceBetween>
        </div>
      </main>
    </div>
  );
}
