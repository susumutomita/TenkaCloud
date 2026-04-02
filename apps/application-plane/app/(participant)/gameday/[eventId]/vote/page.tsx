/**
 * Vote Page (投票)
 *
 * チームカードグリッド、投票ボタン、結果表示
 */

'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  ErrorState,
  getErrorMessage,
  getErrorType,
} from '@/components/ui';
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
      // Check if already voted
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
      <div className="flex justify-center items-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-hn-accent" />
      </div>
    );
  }

  if (error) {
    return (
      <ErrorState
        message={getErrorMessage(error)}
        type={getErrorType(error)}
        onRetry={fetchData}
      />
    );
  }

  // Tally votes per team
  const voteCounts: Record<string, number> = {};
  for (const v of votes) {
    voteCounts[v.votedForTeamId] = (voteCounts[v.votedForTeamId] || 0) + 1;
  }

  const otherTeams = teams.filter((t) => t.teamId !== teamId);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-text-primary flex items-center gap-3">
        <span className="text-hn-accent font-mono">&gt;_</span>
        投票
      </h1>

      {voted && (
        <div className="bg-hn-success/10 border border-hn-success/30 rounded-[var(--radius)] p-4 text-hn-success text-sm">
          投票済みです。ありがとうございます!
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {otherTeams.map((team) => (
          <Card key={team.teamId}>
            <CardContent className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-text-primary text-lg">
                  {team.teamName}
                </span>
                {voteCounts[team.teamId] && (
                  <Badge variant="info" badgeStyle="subtle" size="sm">
                    {voteCounts[team.teamId]} 票
                  </Badge>
                )}
              </div>

              {!voted ? (
                <Button
                  variant="outline"
                  size="sm"
                  fullWidth
                  onClick={() => handleVote(team.teamId)}
                  loading={voting}
                  disabled={voting}
                >
                  投票する
                </Button>
              ) : (
                <div className="text-center text-xs text-text-muted py-1">
                  {voteCounts[team.teamId] || 0} 票獲得
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {otherTeams.length === 0 && (
        <Card className="text-center py-12">
          <p className="text-text-muted">他のチームがまだ登録されていません</p>
        </Card>
      )}
    </div>
  );
}
