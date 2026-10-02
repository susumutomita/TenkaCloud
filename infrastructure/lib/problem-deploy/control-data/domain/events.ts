export interface CloudEventLimits {
  readonly maxTeams: number;
  readonly maxProblems: number;
}
// DynamoDB: event + installation intake fence + replay receipt + two durable rows per team <= 100.
export const CLOUD_EVENT_LIMITS = { maxTeams: 48, maxProblems: 50 } as const;
// SQL uses one atomic batch without DynamoDB's 100-item ceiling; preserve the historical roster.
export const SQL_EVENT_LIMITS = { maxTeams: 99, maxProblems: 50 } as const;

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
  readonly teardownExpected?: number;
  readonly teardownCompleted?: number;
}
