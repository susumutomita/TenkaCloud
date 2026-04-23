/**
 * Event Types
 */

import type { DynamoDBItem } from './base-types';
import type { ProblemType, CloudProvider } from './problem-types';

// Event Status
export const EventStatus = {
  DRAFT: 'DRAFT',
  SCHEDULED: 'SCHEDULED',
  ACTIVE: 'ACTIVE',
  PAUSED: 'PAUSED',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
} as const;

export type EventStatus = (typeof EventStatus)[keyof typeof EventStatus];

// Participant Type
export const ParticipantType = {
  INDIVIDUAL: 'INDIVIDUAL',
  TEAM: 'TEAM',
} as const;

export type ParticipantType =
  (typeof ParticipantType)[keyof typeof ParticipantType];

// Scoring Type
export const ScoringType = {
  REALTIME: 'REALTIME',
  BATCH: 'BATCH',
} as const;

export type ScoringType = (typeof ScoringType)[keyof typeof ScoringType];

// Event Item (DynamoDB)
export interface EventItem extends DynamoDBItem {
  EntityType: 'EVENT';
  id: string;
  externalId: string;
  tenantId: string;
  name: string;
  type: ProblemType;
  status: EventStatus;
  startTime: string;
  endTime: string;
  timezone: string;
  participantType: ParticipantType;
  maxParticipants: number;
  minTeamSize?: number;
  maxTeamSize?: number;
  registrationDeadline?: string;
  cloudProvider: CloudProvider;
  regions: string[];
  scoringType: ScoringType;
  scoringIntervalMinutes: number;
  leaderboardVisible: boolean;
  freezeLeaderboardMinutes?: number;
  createdBy?: string;
}

// Event Domain Type
export interface Event {
  id: string;
  externalId: string;
  tenantId: string;
  name: string;
  type: ProblemType;
  status: EventStatus;
  startTime: Date;
  endTime: Date;
  timezone: string;
  participantType: ParticipantType;
  maxParticipants: number;
  minTeamSize?: number;
  maxTeamSize?: number;
  registrationDeadline?: Date;
  cloudProvider: CloudProvider;
  regions: string[];
  scoringType: ScoringType;
  scoringIntervalMinutes: number;
  leaderboardVisible: boolean;
  freezeLeaderboardMinutes?: number;
  createdBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

// Event Input Types
export interface CreateEventInput {
  externalId?: string;
  tenantId: string;
  name: string;
  type: ProblemType;
  status?: EventStatus;
  startTime: Date;
  endTime: Date;
  timezone?: string;
  participantType: ParticipantType;
  maxParticipants: number;
  minTeamSize?: number;
  maxTeamSize?: number;
  registrationDeadline?: Date;
  cloudProvider: CloudProvider;
  regions: string[];
  scoringType: ScoringType;
  scoringIntervalMinutes: number;
  leaderboardVisible?: boolean;
  freezeLeaderboardMinutes?: number;
  createdBy?: string;
}

export interface UpdateEventInput {
  name?: string;
  status?: EventStatus;
  startTime?: Date;
  endTime?: Date;
  timezone?: string;
  participantType?: ParticipantType;
  maxParticipants?: number;
  minTeamSize?: number;
  maxTeamSize?: number;
  registrationDeadline?: Date;
  cloudProvider?: CloudProvider;
  regions?: string[];
  scoringType?: ScoringType;
  scoringIntervalMinutes?: number;
  leaderboardVisible?: boolean;
  freezeLeaderboardMinutes?: number;
}

// EventProblem Item (DynamoDB)
export interface EventProblemItem extends DynamoDBItem {
  EntityType: 'EVENT_PROBLEM';
  eventId: string;
  problemId: string;
  order: number;
  unlockTime?: string;
  pointMultiplier: number;
}

// EventProblem Domain Type
export interface EventProblem {
  eventId: string;
  problemId: string;
  order: number;
  unlockTime?: Date;
  pointMultiplier: number;
}
