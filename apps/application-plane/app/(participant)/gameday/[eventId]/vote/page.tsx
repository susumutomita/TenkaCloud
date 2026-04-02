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

export default function VotePage() {
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
      const GAMEDAY_API_URL =
        process.env.NEXT_PUBLIC_GAMEDAY_API_URL ||
        'http://localhost:3020/api/gameday';
      const [teamsRes, votesData] = await Promise.all([
        fetch(
          `${GAMEDAY_API_URL}/admin/teams?eventId=${encodeURIComponent(eventId)}`,
        ).then((r) => (r.ok ? r.json() : { teams: [] })),
        getVotingResults(eventId),
      ]);
      setTeams(teamsRes.teams || []);
      setVotes(votesData.results);
      if (votesData.results.some((v: Vote) => v.voterTeamId === teamId)) {
        setVoted(true);
      }
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
            <Button onClick={fetchData}>再試行</Button>
          </SpaceBetween>
        </Box>
      </Container>
    );
  }

  const voteCounts: Record<string, number> = {};
  for (const v of votes) {
    voteCounts[v.votedForTeamId] = (voteCounts[v.votedForTeamId] || 0) + 1;
  }

  const otherTeams = teams.filter((t) => t.teamId !== teamId);

  return (
    <SpaceBetween size="l">
      <Header variant="h1">投票</Header>

      {voted && (
        <StatusIndicator type="success">
          投票済みです。ありがとうございます!
        </StatusIndicator>
      )}

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
                <Badge color="blue">{voteCounts[team.teamId]} 票</Badge>
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
                    投票する
                  </Button>
                ) : (
                  <Box textAlign="center" color="text-body-secondary">
                    {voteCounts[team.teamId] || 0} 票獲得
                  </Box>
                ),
            },
          ],
        }}
        empty={
          <Box textAlign="center" padding="l" color="text-body-secondary">
            他のチームがまだ登録されていません
          </Box>
        }
      />
    </SpaceBetween>
  );
}
