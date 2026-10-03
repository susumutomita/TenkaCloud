export interface ControlDataQuotaProfile {
  readonly participantCount: number;
  readonly leaderboardPollIntervalSeconds: number;
  readonly eventDurationHours: number;
  readonly summaryRowWrites: number;
  readonly snapshotRefreshIntervalSeconds: number;
}

export interface ControlDataQuotaEstimate {
  readonly leaderboardSnapshotRowReads: number;
  readonly summaryRowWrites: number;
  readonly snapshotRowWrites: number;
  readonly totalRowWrites: number;
  readonly monthlyReadUtilization: number;
  readonly monthlyWriteUtilization: number;
  readonly withinFreeQuota: boolean;
}

export const TURSO_FREE_MONTHLY_ROWS_READ = 500_000_000;
export const TURSO_FREE_MONTHLY_ROWS_WRITTEN = 10_000_000;

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

/**
 * Models the event-day data flow at SQL row granularity.
 *
 * The participant route reads one materialized leaderboard snapshot per poll.
 * Runtime scoring writes one summary row per changed team, while snapshot
 * regeneration writes one row per refresh interval. This intentionally excludes
 * raw score events because they remain in the runtime DynamoDB table.
 */
export function estimateControlDataQuota(
  profile: ControlDataQuotaProfile,
): ControlDataQuotaEstimate {
  const participants = positiveInteger(profile.participantCount, "participantCount");
  const pollSeconds = positiveInteger(
    profile.leaderboardPollIntervalSeconds,
    "leaderboardPollIntervalSeconds",
  );
  const durationHours = positiveInteger(profile.eventDurationHours, "eventDurationHours");
  const summaryRowWrites = positiveInteger(profile.summaryRowWrites, "summaryRowWrites");
  const snapshotSeconds = positiveInteger(
    profile.snapshotRefreshIntervalSeconds,
    "snapshotRefreshIntervalSeconds",
  );
  const eventSeconds = durationHours * 60 * 60;
  const pollsPerParticipant = Math.ceil(eventSeconds / pollSeconds);
  const snapshotRowWrites = Math.ceil(eventSeconds / snapshotSeconds);
  const leaderboardSnapshotRowReads = participants * pollsPerParticipant;
  const totalRowWrites = summaryRowWrites + snapshotRowWrites;

  return {
    leaderboardSnapshotRowReads,
    summaryRowWrites,
    snapshotRowWrites,
    totalRowWrites,
    monthlyReadUtilization: leaderboardSnapshotRowReads / TURSO_FREE_MONTHLY_ROWS_READ,
    monthlyWriteUtilization: totalRowWrites / TURSO_FREE_MONTHLY_ROWS_WRITTEN,
    withinFreeQuota:
      leaderboardSnapshotRowReads <= TURSO_FREE_MONTHLY_ROWS_READ &&
      totalRowWrites <= TURSO_FREE_MONTHLY_ROWS_WRITTEN,
  };
}
