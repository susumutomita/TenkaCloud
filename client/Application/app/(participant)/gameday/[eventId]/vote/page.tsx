/**
 * Vote Page (投票)
 *
 * GameDay の投票対象と得票状況を一覧する。
 */

'use client';

import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Cards from '@cloudscape-design/components/cards';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import '@cloudscape-design/global-styles/index.css';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  getParticipantTeams,
  getVotingResults,
  submitVote,
} from '@/lib/api/gameday';
import type { Team, Vote } from '@/lib/api/gameday-types';
import { DeploymentGate } from '@/components/gameday/deployment-gate';
import { useGamedaySession } from '@/lib/hooks/use-gameday-session';
import { useI18n } from '@/lib/i18n';

interface VoteCandidate extends Team {
  votes: number;
}

export default function VotePage() {
  const { t, locale } = useI18n();
  const { eventId, teamId } = useGamedaySession();
  const [teams, setTeams] = useState<Team[]>([]);
  const [votes, setVotes] = useState<Vote[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [votingTeamId, setVotingTeamId] = useState<string | null>(null);
  const [votedTeamId, setVotedTeamId] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    if (!eventId) return;

    try {
      const [teamsData, votingResults] = await Promise.all([
        getParticipantTeams(eventId),
        getVotingResults(eventId),
      ]);

      setTeams(teamsData.teams);
      setVotes(votingResults.results);

      const myVote = votingResults.results.find(
        (vote) => vote.voterTeamId === teamId,
      );
      setVotedTeamId(myVote?.votedForTeamId ?? null);
      setError(null);
    } catch (err) {
      setError(
        err instanceof Error ? err : new Error('読み込みに失敗しました'),
      );
    } finally {
      setLoading(false);
    }
  }, [eventId, teamId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleVote = async (targetTeamId: string) => {
    if (!eventId || !teamId || votedTeamId) return;

    setVotingTeamId(targetTeamId);
    try {
      await submitVote(eventId, teamId, targetTeamId);
      await fetchData();
    } catch {
      // Display is driven by the latest fetch result. Ignore button-level errors here.
    } finally {
      setVotingTeamId(null);
    }
  };

  const voteCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const vote of votes) {
      counts[vote.votedForTeamId] = (counts[vote.votedForTeamId] || 0) + 1;
    }
    return counts;
  }, [votes]);

  const otherTeams = useMemo(
    () => teams.filter((team) => team.teamId !== teamId),
    [teamId, teams],
  );

  const voteCandidates = useMemo<VoteCandidate[]>(
    () =>
      otherTeams
        .map((team) => ({
          ...team,
          votes: voteCounts[team.teamId] || 0,
        }))
        .sort(
          (left, right) =>
            right.votes - left.votes ||
            left.teamName.localeCompare(right.teamName),
        ),
    [otherTeams, voteCounts],
  );

  const totalVotes = votes.length;
  const leadingCandidate =
    voteCandidates[0]?.votes > 0 ? voteCandidates[0] : null;
  const votedForTeam = votedTeamId
    ? (voteCandidates.find((team) => team.teamId === votedTeamId) ?? null)
    : null;

  if (loading) {
    return (
      <Box textAlign="center" padding="xxl">
        <Spinner size="large" />
      </Box>
    );
  }

  if (error) {
    return (
      <Container>
        <Box textAlign="center" padding="xl">
          <SpaceBetween size="m">
            <StatusIndicator type="error">{error.message}</StatusIndicator>
            <Button onClick={fetchData}>{t('common.retry')}</Button>
          </SpaceBetween>
        </Box>
      </Container>
    );
  }

  return (
    <DeploymentGate eventId={eventId}>
      <SpaceBetween size="l">
        <Header variant="h1" description={t('gameday.votingDescription')}>
          {t('gameday.voting')}
        </Header>

        <ColumnLayout columns={3}>
          <Container>
            <Box variant="awsui-key-label">
              {locale === 'ja' ? '投票対象' : 'Candidates'}
            </Box>
            <Box variant="awsui-value-large">{voteCandidates.length}</Box>
          </Container>
          <Container>
            <Box variant="awsui-key-label">
              {locale === 'ja' ? '総投票数' : 'Total votes'}
            </Box>
            <Box variant="awsui-value-large">{totalVotes}</Box>
          </Container>
          <Container>
            <Box variant="awsui-key-label">
              {locale === 'ja' ? '投票状況' : 'Your status'}
            </Box>
            <Box variant="awsui-value-large">
              {votedTeamId ? (
                <StatusIndicator type="success">
                  {locale === 'ja' ? '投票済み' : 'Submitted'}
                </StatusIndicator>
              ) : (
                <StatusIndicator type="pending">
                  {locale === 'ja' ? '未投票' : 'Pending'}
                </StatusIndicator>
              )}
            </Box>
          </Container>
        </ColumnLayout>

        {votedTeamId ? (
          <Container>
            <StatusIndicator type="success">
              {t('gameday.votedMessage')}
              {' — '}
              {locale === 'ja'
                ? `投票先: ${votedForTeam?.teamName ?? votedTeamId}`
                : `Voted for ${votedForTeam?.teamName ?? votedTeamId}`}
            </StatusIndicator>
          </Container>
        ) : null}

        <Container
          header={
            <Header
              counter={`(${leadingCandidate ? leadingCandidate.votes : 0})`}
            >
              {locale === 'ja' ? '現在のトップ' : 'Current leader'}
            </Header>
          }
        >
          <Box fontSize="heading-l" fontWeight="bold">
            {leadingCandidate?.teamName ??
              (locale === 'ja' ? 'まだなし' : 'No votes yet')}
          </Box>
          <Box color="text-body-secondary">
            {leadingCandidate
              ? `${leadingCandidate.votes} ${t('gameday.voteCount')}`
              : locale === 'ja'
                ? '最初の一票を待っています。'
                : 'Waiting for the first vote.'}
          </Box>
        </Container>

        <Cards
          header={
            <Header
              counter={`(${voteCandidates.length})`}
              description={
                locale === 'ja'
                  ? '各チームの得票状況を見ながら 1 チームに投票できます。'
                  : 'Review each team and cast one vote for the strongest performance.'
              }
            >
              {locale === 'ja' ? '投票対象チーム' : 'Vote targets'}
            </Header>
          }
          items={voteCandidates}
          cardsPerRow={[{ cards: 1 }, { minWidth: 400, cards: 2 }]}
          cardDefinition={{
            header: (team) => team.teamName,
            sections: [
              {
                id: 'stats',
                content: (team) => (
                  <SpaceBetween direction="horizontal" size="l">
                    <Box variant="small">
                      {locale === 'ja' ? '順位' : 'Standing'}:{' '}
                      <b>#{voteCandidates.indexOf(team) + 1}</b>
                    </Box>
                    <Box variant="small">
                      {locale === 'ja' ? '得票' : 'Votes'}: <b>{team.votes}</b>
                    </Box>
                  </SpaceBetween>
                ),
              },
              {
                id: 'action',
                content: (team) => {
                  if (votedTeamId) {
                    return (
                      <Box textAlign="center" color="text-body-secondary">
                        {votedTeamId === team.teamId
                          ? locale === 'ja'
                            ? 'このチームに投票しました'
                            : 'You voted for this team'
                          : `${team.votes} ${t('gameday.votesReceived')}`}
                      </Box>
                    );
                  }
                  return (
                    <Button
                      fullWidth
                      variant="primary"
                      onClick={() => handleVote(team.teamId)}
                      loading={votingTeamId === team.teamId}
                      disabled={votingTeamId !== null}
                    >
                      {t('gameday.voteAction')}
                    </Button>
                  );
                },
              },
            ],
          }}
          empty={t('gameday.noOtherTeams')}
        />

        <Table
          header={
            <Header
              description={
                locale === 'ja'
                  ? '現在の得票順にチームを並べています。'
                  : 'Teams are ordered by current vote count.'
              }
            >
              {locale === 'ja' ? '得票ボード' : 'Vote board'}
            </Header>
          }
          items={voteCandidates}
          columnDefinitions={[
            {
              id: 'rank',
              header: '#',
              cell: (_team) => voteCandidates.indexOf(_team) + 1,
              width: 60,
            },
            {
              id: 'team',
              header: locale === 'ja' ? 'チーム' : 'Team',
              cell: (team) => <Box fontWeight="bold">{team.teamName}</Box>,
            },
            {
              id: 'status',
              header: locale === 'ja' ? '状態' : 'Status',
              cell: (team) =>
                votedTeamId === team.teamId ? (
                  <StatusIndicator type="success">
                    {locale === 'ja' ? 'あなたの投票先' : 'Your vote'}
                  </StatusIndicator>
                ) : (
                  <Box color="text-body-secondary">
                    {locale === 'ja' ? '投票対象' : 'Eligible target'}
                  </Box>
                ),
            },
            {
              id: 'votes',
              header: t('gameday.voteCount'),
              cell: (team) => <Box fontWeight="bold">{team.votes}</Box>,
              width: 100,
            },
          ]}
          empty={t('gameday.noOtherTeams')}
          sortingDisabled
        />
      </SpaceBetween>
    </DeploymentGate>
  );
}
