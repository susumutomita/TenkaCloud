import type { Battle, BattleParticipant } from '@tenkacloud/dynamodb';
import { BattleStatus } from '@tenkacloud/dynamodb';
import type { BattleRepository } from '@tenkacloud/dynamodb';

export interface LeaderboardEntry {
  rank: number;
  userId: string;
  score: number;
  updatedAt: Date;
}

export interface LeaderboardResult {
  battleId: string;
  battleTitle: string;
  status: string;
  frozen: boolean;
  entries: LeaderboardEntry[];
  updatedAt: Date;
}

const DEFAULT_FREEZE_MINUTES = 10;

export function isLeaderboardFrozen(
  battle: Battle,
  freezeMinutes: number = DEFAULT_FREEZE_MINUTES,
  now: Date = new Date()
): boolean {
  if (battle.status !== BattleStatus.RUNNING) {
    return false;
  }

  if (!battle.startedAt) {
    return false;
  }

  const expectedEndMs = battle.startedAt.getTime() + battle.timeLimit * 1000;
  const freezeStartMs = expectedEndMs - freezeMinutes * 60 * 1000;

  return now.getTime() >= freezeStartMs;
}

export function buildLeaderboard(
  participants: BattleParticipant[]
): LeaderboardEntry[] {
  const active = participants.filter((p) => !p.leftAt);

  const sorted = [...active].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.joinedAt.getTime() - b.joinedAt.getTime();
  });

  return sorted.map((p, index) => ({
    rank: index + 1,
    userId: p.userId,
    score: p.score,
    updatedAt: p.joinedAt,
  }));
}

export async function getLeaderboard(
  battleId: string,
  tenantId: string,
  repository: BattleRepository,
  freezeMinutes?: number
): Promise<LeaderboardResult | null> {
  const battle = await repository.findByIdAndTenant(battleId, tenantId);
  if (!battle) {
    return null;
  }

  if (
    battle.status === BattleStatus.DRAFT ||
    battle.status === BattleStatus.OPEN
  ) {
    return {
      battleId: battle.id,
      battleTitle: battle.title,
      status: battle.status,
      frozen: false,
      entries: [],
      updatedAt: battle.updatedAt,
    };
  }

  const participants = await repository.listParticipants(battleId);
  const frozen = isLeaderboardFrozen(battle, freezeMinutes);
  const entries = buildLeaderboard(participants);

  return {
    battleId: battle.id,
    battleTitle: battle.title,
    status: battle.status,
    frozen,
    entries,
    updatedAt: battle.updatedAt,
  };
}
