/**
 * Vote Page (投票)
 *
 * Cloudscape Design System — チームカードグリッド、投票ボタン、結果表示
 */

'use client';

import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Cards from '@cloudscape-design/components/cards';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import '@cloudscape-design/global-styles/index.css';
import { useCallback, useEffect, useState } from 'react';
import { getVotingResults, submitVote } from '@/lib/api/gameday';
import type { Team, Vote } from '@/lib/api/gameday-types';
import { useGamedaySession } from '@/lib/hooks/use-gameday-session';
import { useI18n } from '@/lib/i18n';

export default function VotePage() {
  const { t } = useI18n();
  const { eventId, teamId } = useGamedaySession();
  const [teams, setTeams] = useState<Team[]>([]);
  const [votes, setVotes] = useState<Vote[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [voting, setVoting] = useState(false);
  const [voted, setVoted] = useState(false);

  const fetchData = useCallback(async () => {
    if (!eventId) return;
    try {
      const gamedayApiUrl =
        process.env.NEXT_PUBLIC_GAMEDAY_API_URL ||
        'http://localhost:3020/api/gameday';
      const [teamsRes, votesData] = await Promise.all([
        fetch(
          `${gamedayApiUrl}/admin/teams?eventId=${encodeURIComponent(eventId)}`
        ).then((response) => (response.ok ? response.json() : { teams: [] })),
        getVotingResults(eventId),
      ]);
      setTeams(teamsRes.teams || []);
      setVotes(votesData.results);
      if (votesData.results.some((vote: Vote) => vote.voterTeamId === teamId)) {
        setVoted(true);
      }
      setError(null);
    } catch (err) {
      setError(
        err instanceof Error ? err : new Error('読み込みに失敗しました')
      );
    } finally {
      setLoading(false);
    }
  }, [eventId, teamId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleVote = async (votedForTeamId: string) => {
    if (!eventId || !teamId || voted) return;
    setVoting(true);
    try {
      await submitVote(eventId, teamId, votedForTeamId);
      setVoted(true);
      await fetchData();
    } catch {
      // ignore
    } finally {
      setVoting(false);
    }
  };

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

  const voteCounts: Record<string, number> = {};
  for (const vote of votes) {
    voteCounts[vote.votedForTeamId] =
      (voteCounts[vote.votedForTeamId] || 0) + 1;
  }

  const otherTeams = teams.filter((team) => team.teamId !== teamId);

  return (
    <SpaceBetween size="l">
      <Header variant="h1" description={t('gameday.votingDescription')}>
        {t('gameday.voting')}
      </Header>

      {voted ? (
        <StatusIndicator type="success">
          {t('gameday.votedMessage')}
        </StatusIndicator>
      ) : null}

      <Cards
        items={otherTeams}
        cardsPerRow={[
          { cards: 1 },
          { minWidth: 400, cards: 2 },
          { minWidth: 700, cards: 3 },
        ]}
        cardDefinition={{
          header: (team) => (
            <SpaceBetween direction="horizontal" size="xs">
              <span>{team.teamName}</span>
              {voteCounts[team.teamId] ? (
                <Badge color="blue">
                  {voteCounts[team.teamId]} {t('gameday.voteCount')}
                </Badge>
              ) : null}
            </SpaceBetween>
          ),
          sections: [
            {
              id: 'action',
              content: (team) =>
                !voted ? (
                  <Button
                    fullWidth
                    onClick={() => handleVote(team.teamId)}
                    loading={voting}
                    disabled={voting}
                  >
                    {t('gameday.voteAction')}
                  </Button>
                ) : (
                  <Box textAlign="center" color="text-body-secondary">
                    {voteCounts[team.teamId] || 0} {t('gameday.votesReceived')}
                  </Box>
                ),
            },
          ],
        }}
        empty={
          <Box textAlign="center" padding="l" color="text-body-secondary">
            {t('gameday.noOtherTeams')}
          </Box>
        }
      />
    </SpaceBetween>
  );
}
