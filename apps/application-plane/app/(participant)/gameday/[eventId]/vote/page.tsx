/**
 * Vote Page (投票)
 *
 * GameDay の投票対象と得票状況を一覧する。
 */

'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  getParticipantTeams,
  getVotingResults,
  submitVote,
} from '@/lib/api/gameday';
import type { Team, Vote } from '@/lib/api/gameday-types';
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
  const leadingCandidate = voteCandidates[0] ?? null;

  if (loading) {
    return (
      <div className="flex justify-center items-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-hn-accent" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-[28px] border border-hn-error/30 bg-hn-error/10 p-8">
        <div className="flex flex-col items-center gap-4 text-center">
          <p className="text-sm text-hn-error">{error.message}</p>
          <button
            type="button"
            onClick={fetchData}
            className="rounded-full border border-border bg-surface-3 px-4 py-2 text-sm font-semibold text-text-primary hover:bg-surface-2 transition-colors"
          >
            {t('common.retry')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <section className="rounded-[32px] border border-border bg-surface-2/90 p-6 shadow-[0_20px_60px_rgba(0,0,0,0.18)] backdrop-blur-sm">
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(340px,0.9fr)]">
          <div className="space-y-4">
            <div className="inline-flex items-center rounded-full border border-hn-accent/35 bg-hn-accent/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.24em] text-hn-accent">
              {t('gameday.voteNav')}
            </div>
            <div className="space-y-2">
              <h1 className="text-4xl font-black tracking-tight text-text-primary">
                {t('gameday.voting')}
              </h1>
              <p className="max-w-2xl text-sm leading-7 text-text-secondary">
                {t('gameday.votingDescription')}
              </p>
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              <VoteStatCard
                label={locale === 'ja' ? '投票対象' : 'Candidates'}
                value={String(voteCandidates.length)}
                tone="neutral"
              />
              <VoteStatCard
                label={locale === 'ja' ? '総投票数' : 'Total votes'}
                value={String(totalVotes)}
                tone="accent"
              />
              <VoteStatCard
                label={locale === 'ja' ? '投票状況' : 'Your status'}
                value={
                  votedTeamId
                    ? locale === 'ja'
                      ? '投票済み'
                      : 'Submitted'
                    : locale === 'ja'
                      ? '未投票'
                      : 'Pending'
                }
                tone={votedTeamId ? 'success' : 'neutral'}
              />
            </div>
          </div>

          <aside className="rounded-[28px] border border-border bg-surface-3 p-5">
            <div className="space-y-4">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-text-muted">
                  {locale === 'ja' ? '現在のトップ' : 'Current leader'}
                </div>
                <div className="mt-2 text-2xl font-bold text-text-primary">
                  {leadingCandidate?.teamName ??
                    (locale === 'ja' ? 'まだなし' : 'No votes yet')}
                </div>
                <div className="mt-1 text-sm text-text-secondary">
                  {leadingCandidate
                    ? `${leadingCandidate.votes} ${t('gameday.voteCount')}`
                    : locale === 'ja'
                      ? '最初の一票を待っています。'
                      : 'Waiting for the first vote.'}
                </div>
              </div>
              <div className="rounded-2xl border border-border bg-surface-2 px-4 py-3 text-sm text-text-secondary">
                {votedTeamId
                  ? locale === 'ja'
                    ? '投票後はリアルタイムで得票状況だけを確認できます。'
                    : 'After voting, you can keep tracking the live tally.'
                  : locale === 'ja'
                    ? '他チームを 1 つ選んで投票してください。自チームへの投票はできません。'
                    : 'Pick one other team to cast your vote. Self-voting is not allowed.'}
              </div>
            </div>
          </aside>
        </div>
      </section>

      {votedTeamId ? (
        <section className="rounded-[28px] border border-emerald-500/35 bg-emerald-500/10 px-5 py-4 text-sm text-emerald-200">
          <div className="flex items-center gap-3">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-emerald-500/20 text-base">
              ✓
            </span>
            <div>
              <div className="font-semibold text-emerald-100">
                {t('gameday.votedMessage')}
              </div>
              <div className="text-emerald-200/80">
                {locale === 'ja'
                  ? `投票先: ${voteCandidates.find((team) => team.teamId === votedTeamId)?.teamName ?? votedTeamId}`
                  : `Voted for ${voteCandidates.find((team) => team.teamId === votedTeamId)?.teamName ?? votedTeamId}`}
              </div>
            </div>
          </div>
        </section>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.7fr)_minmax(320px,0.85fr)]">
        <section className="rounded-[32px] border border-border bg-surface-2/90 p-6">
          <div className="mb-5 flex items-end justify-between gap-4">
            <div>
              <h2 className="text-2xl font-bold text-text-primary">
                {locale === 'ja' ? '投票対象チーム' : 'Vote targets'}
              </h2>
              <p className="mt-1 text-sm text-text-secondary">
                {locale === 'ja'
                  ? '各チームの得票状況を見ながら 1 チームに投票できます。'
                  : 'Review each team and cast one vote for the strongest performance.'}
              </p>
            </div>
            <div className="rounded-full border border-border bg-surface-3 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-text-secondary">
              {voteCandidates.length} {locale === 'ja' ? 'チーム' : 'teams'}
            </div>
          </div>

          {voteCandidates.length === 0 ? (
            <div className="rounded-[24px] border border-dashed border-border bg-surface-3 px-6 py-16 text-center text-text-secondary">
              <div className="text-lg font-semibold text-text-primary">
                {t('gameday.noOtherTeams')}
              </div>
              <p className="mt-2 text-sm">
                {locale === 'ja'
                  ? '投票を始めるには、別の参加チームが登録される必要があります。'
                  : 'Another registered team is required before voting becomes available.'}
              </p>
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {voteCandidates.map((team, index) => {
                const isLeading = index === 0 && team.votes > 0;
                const isSelected = votedTeamId === team.teamId;

                return (
                  <article
                    key={team.teamId}
                    className={`rounded-[26px] border p-5 transition-colors ${
                      isSelected
                        ? 'border-emerald-400/60 bg-emerald-500/10'
                        : isLeading
                          ? 'border-hn-accent/50 bg-hn-accent/10'
                          : 'border-border bg-surface-3'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-xs font-semibold uppercase tracking-[0.2em] text-text-muted">
                          {locale === 'ja'
                            ? `候補 ${index + 1}`
                            : `Candidate ${index + 1}`}
                        </div>
                        <h3 className="mt-2 text-xl font-bold text-text-primary">
                          {team.teamName}
                        </h3>
                      </div>
                      <div className="rounded-full border border-border bg-surface-2 px-3 py-1 text-sm font-semibold text-text-primary">
                        {team.votes} {t('gameday.voteCount')}
                      </div>
                    </div>

                    <div className="mt-5 grid grid-cols-2 gap-3">
                      <VoteMiniStat
                        label={locale === 'ja' ? '現在順位' : 'Standing'}
                        value={`#${index + 1}`}
                      />
                      <VoteMiniStat
                        label={locale === 'ja' ? '得票' : 'Votes'}
                        value={String(team.votes)}
                      />
                    </div>

                    <div className="mt-5">
                      {votedTeamId ? (
                        <div className="rounded-2xl border border-border bg-surface-2 px-4 py-3 text-center text-sm text-text-secondary">
                          {isSelected
                            ? locale === 'ja'
                              ? 'このチームに投票しました'
                              : 'You voted for this team'
                            : `${team.votes} ${t('gameday.votesReceived')}`}
                        </div>
                      ) : (
                        <button
                          type="button"
                          className={`w-full rounded-2xl px-4 py-3 text-sm font-semibold transition-colors disabled:opacity-50 ${
                            isLeading
                              ? 'bg-hn-accent text-white hover:bg-hn-accent/90'
                              : 'border border-border bg-surface-3 text-text-primary hover:bg-surface-2'
                          }`}
                          onClick={() => handleVote(team.teamId)}
                          disabled={votingTeamId !== null}
                        >
                          {votingTeamId === team.teamId ? (
                            <span className="flex items-center justify-center gap-2">
                              <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                              {t('gameday.voteAction')}
                            </span>
                          ) : (
                            t('gameday.voteAction')
                          )}
                        </button>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>

        <aside className="rounded-[32px] border border-border bg-surface-2/90 p-6">
          <div className="mb-5">
            <h2 className="text-2xl font-bold text-text-primary">
              {locale === 'ja' ? '得票ボード' : 'Vote board'}
            </h2>
            <p className="mt-1 text-sm text-text-secondary">
              {locale === 'ja'
                ? '現在の得票順にチームを並べています。'
                : 'Teams are ordered by current vote count.'}
            </p>
          </div>

          {voteCandidates.length === 0 ? (
            <div className="rounded-[24px] border border-dashed border-border bg-surface-3 px-5 py-10 text-center text-sm text-text-secondary">
              {t('gameday.noOtherTeams')}
            </div>
          ) : (
            <div className="space-y-3">
              {voteCandidates.map((team, index) => (
                <div
                  key={team.teamId}
                  className="flex items-center justify-between rounded-2xl border border-border bg-surface-3 px-4 py-3"
                >
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-surface-2 text-sm font-black text-text-primary">
                      {index + 1}
                    </div>
                    <div>
                      <div className="font-semibold text-text-primary">
                        {team.teamName}
                      </div>
                      <div className="text-xs text-text-muted">
                        {votedTeamId === team.teamId
                          ? locale === 'ja'
                            ? 'あなたの投票先'
                            : 'Your vote'
                          : locale === 'ja'
                            ? '投票対象'
                            : 'Eligible target'}
                      </div>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-lg font-bold text-text-primary">
                      {team.votes}
                    </div>
                    <div className="text-xs uppercase tracking-[0.18em] text-text-muted">
                      {t('gameday.voteCount')}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function VoteStatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'neutral' | 'accent' | 'success';
}) {
  const toneClass =
    tone === 'accent'
      ? 'border-hn-accent/35 bg-hn-accent/10'
      : tone === 'success'
        ? 'border-emerald-500/35 bg-emerald-500/10'
        : 'border-border bg-surface-3';

  return (
    <div className={`rounded-[24px] border px-4 py-4 ${toneClass}`}>
      <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-text-muted">
        {label}
      </div>
      <div className="mt-2 text-2xl font-black text-text-primary">{value}</div>
    </div>
  );
}

function VoteMiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-border bg-surface-2 px-3 py-3">
      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-text-muted">
        {label}
      </div>
      <div className="mt-1 text-lg font-semibold text-text-primary">
        {value}
      </div>
    </div>
  );
}
