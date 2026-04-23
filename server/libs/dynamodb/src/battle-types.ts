/**
 * Battle Service Types
 */

import type { DynamoDBItem } from './base-types';

// Battle Status
export const BattleStatus = {
  DRAFT: 'DRAFT',
  OPEN: 'OPEN',
  RUNNING: 'RUNNING',
  FINISHED: 'FINISHED',
  ARCHIVED: 'ARCHIVED',
} as const;

export type BattleStatus = (typeof BattleStatus)[keyof typeof BattleStatus];

// Battle Mode
export const BattleMode = {
  INDIVIDUAL: 'INDIVIDUAL',
  TEAM: 'TEAM',
} as const;

export type BattleMode = (typeof BattleMode)[keyof typeof BattleMode];

// Battle Entity Item
export interface BattleItem extends DynamoDBItem {
  EntityType: 'BATTLE';
  id: string;
  tenantId: string;
  title: string;
  description?: string;
  mode: BattleMode;
  status: BattleStatus;
  maxParticipants: number;
  timeLimit: number;
  startedAt?: string;
  endedAt?: string;
}

// Battle Participant Item
export interface BattleParticipantItem extends DynamoDBItem {
  EntityType: 'BATTLE_PARTICIPANT';
  id: string;
  battleId: string;
  userId: string;
  teamId?: string;
  score: number;
  rank?: number;
  joinedAt: string;
  leftAt?: string;
}

// Battle Team Item
export interface BattleTeamItem extends DynamoDBItem {
  EntityType: 'BATTLE_TEAM';
  id: string;
  battleId: string;
  name: string;
  score: number;
}

// Battle History Item
export interface BattleHistoryItem extends DynamoDBItem {
  EntityType: 'BATTLE_HISTORY';
  id: string;
  battleId: string;
  eventType: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

// Battle Domain Types
export interface Battle {
  id: string;
  tenantId: string;
  title: string;
  description?: string;
  mode: BattleMode;
  status: BattleStatus;
  maxParticipants: number;
  timeLimit: number;
  startedAt?: Date;
  endedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface BattleParticipant {
  id: string;
  battleId: string;
  userId: string;
  teamId?: string;
  score: number;
  rank?: number;
  joinedAt: Date;
  leftAt?: Date;
}

export interface BattleTeam {
  id: string;
  battleId: string;
  name: string;
  score: number;
  createdAt: Date;
}

export interface BattleHistory {
  id: string;
  battleId: string;
  eventType: string;
  payload: Record<string, unknown>;
  timestamp: Date;
}

// Battle Input Types
export interface CreateBattleInput {
  tenantId: string;
  title: string;
  description?: string;
  mode: BattleMode;
  maxParticipants?: number;
  timeLimit?: number;
}

export interface UpdateBattleInput {
  title?: string;
  description?: string;
  maxParticipants?: number;
  timeLimit?: number;
  status?: BattleStatus;
  startedAt?: Date;
  endedAt?: Date;
}
