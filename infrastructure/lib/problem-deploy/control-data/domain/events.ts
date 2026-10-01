export const CLOUD_EVENT_LIMITS = { maxTeams: 49, maxProblems: 50 } as const;

/** Restored event wire/domain fields from 825415fc; one installation has no tenant axis. */
export type EventStatus = "DRAFT" | "DEPLOYING" | "READY" | "ENDED" | "TEARDOWN" | "ARCHIVED";
export interface EventProblemTarget {
  readonly problemId: string;
  readonly defaultRegion: string;
  readonly defaultAwsAccountId?: string;
}
export interface EventRecord {
  readonly eventId: string;
  readonly name: string;
  readonly status: EventStatus;
  readonly problems: readonly EventProblemTarget[];
  readonly teamCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: number;
  readonly startsAt?: string;
  readonly endsAt?: string;
  readonly scoringLocked?: boolean;
  readonly scoreboardFreezeMinutes?: number;
}
