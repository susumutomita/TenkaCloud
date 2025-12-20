import {
  BattleStatus,
  type BattleMode,
  type Battle,
  type BattleParticipant,
} from '@tenkacloud/dynamodb';
import { battleRepository } from '../lib/dynamodb';

export interface CreateBattleInput {
  tenantId: string;
  title: string;
  description?: string;
  mode: BattleMode;
  maxParticipants: number;
  timeLimit: number;
}

export interface ListBattlesOptions {
  page: number;
  limit: number;
  status?: (typeof BattleStatus)[keyof typeof BattleStatus];
}

export interface UpdateBattleInput {
  title?: string;
  description?: string;
  maxParticipants?: number;
  timeLimit?: number;
}

export async function createBattle(input: CreateBattleInput): Promise<Battle> {
  return battleRepository.create({
    tenantId: input.tenantId,
    title: input.title,
    description: input.description,
    mode: input.mode,
    maxParticipants: input.maxParticipants,
    timeLimit: input.timeLimit,
  });
}

export async function getBattle(
  battleId: string,
  tenantId: string
): Promise<(Battle & { participants: BattleParticipant[] }) | null> {
  const battle = await battleRepository.findByIdAndTenant(battleId, tenantId);

  if (!battle) {
    return null;
  }

  const participants = await battleRepository.listParticipants(battleId);

  return {
    ...battle,
    participants,
  };
}

export async function listBattles(
  tenantId: string,
  options: ListBattlesOptions
): Promise<{ data: Battle[]; total: number; page: number; limit: number }> {
  const { page, limit, status } = options;

  const [listResult, total] = await Promise.all([
    battleRepository.listByTenant(tenantId, {
      status,
      limit,
    }),
    battleRepository.countByTenant(tenantId, status),
  ]);

  return {
    data: listResult.battles,
    total,
    page,
    limit,
  };
}

export async function updateBattle(
  battleId: string,
  tenantId: string,
  updates: UpdateBattleInput
): Promise<Battle | null> {
  const battle = await battleRepository.findByIdAndTenant(battleId, tenantId);

  if (!battle) {
    return null;
  }

  if (battle.status === BattleStatus.IN_PROGRESS) {
    throw new Error('進行中のバトルは更新できません');
  }

  return battleRepository.update(battleId, updates);
}

export async function deleteBattle(
  battleId: string,
  tenantId: string
): Promise<void> {
  const battle = await battleRepository.findByIdAndTenant(battleId, tenantId);

  if (!battle) {
    return;
  }

  if (battle.status === BattleStatus.IN_PROGRESS) {
    throw new Error('進行中のバトルは削除できません');
  }

  await battleRepository.delete(battleId);
}

export async function startBattle(
  battleId: string,
  tenantId: string
): Promise<Battle | null> {
  const battle = await battleRepository.findByIdAndTenant(battleId, tenantId);

  if (!battle) {
    return null;
  }

  if (battle.status !== BattleStatus.WAITING) {
    throw new Error('待機中のバトルのみ開始できます');
  }

  const participantCount =
    await battleRepository.countActiveParticipants(battleId);

  if (participantCount === 0) {
    throw new Error('参加者がいないためバトルを開始できません');
  }

  const updatedBattle = await battleRepository.update(battleId, {
    status: BattleStatus.IN_PROGRESS,
    startedAt: new Date(),
  });

  await battleRepository.addHistory(battleId, 'BATTLE_STARTED', {
    participantCount,
  });

  return updatedBattle;
}

export async function endBattle(
  battleId: string,
  tenantId: string
): Promise<Battle | null> {
  const battle = await battleRepository.findByIdAndTenant(battleId, tenantId);

  if (!battle) {
    return null;
  }

  if (battle.status !== BattleStatus.IN_PROGRESS) {
    throw new Error('進行中でないバトルは終了できません');
  }

  const updatedBattle = await battleRepository.update(battleId, {
    status: BattleStatus.FINISHED,
    endedAt: new Date(),
  });

  await battleRepository.addHistory(battleId, 'BATTLE_ENDED', {});

  return updatedBattle;
}

export async function joinBattle(
  battleId: string,
  tenantId: string,
  userId: string,
  teamId?: string
): Promise<BattleParticipant> {
  const battle = await battleRepository.findByIdAndTenant(battleId, tenantId);

  if (!battle) {
    throw new Error('バトルが見つかりません');
  }

  if (battle.status !== BattleStatus.WAITING) {
    throw new Error('待機中のバトルにのみ参加できます');
  }

  const currentCount = await battleRepository.countActiveParticipants(battleId);

  if (currentCount >= battle.maxParticipants) {
    throw new Error('バトルの定員に達しています');
  }

  const existing = await battleRepository.getParticipant(battleId, userId);

  if (existing && !existing.leftAt) {
    throw new Error('既にこのバトルに参加しています');
  }

  return battleRepository.addParticipant(battleId, userId, teamId);
}

export async function leaveBattle(
  battleId: string,
  tenantId: string,
  userId: string
): Promise<void> {
  const battle = await battleRepository.findByIdAndTenant(battleId, tenantId);

  if (!battle) {
    throw new Error('バトルが見つかりません');
  }

  if (battle.status === BattleStatus.IN_PROGRESS) {
    throw new Error('進行中のバトルからは退出できません');
  }

  const participant = await battleRepository.getParticipant(battleId, userId);

  if (!participant) {
    throw new Error('参加者が見つかりません');
  }

  await battleRepository.updateParticipant(battleId, userId, {
    leftAt: new Date(),
  });
}

export async function updateScore(
  battleId: string,
  tenantId: string,
  userId: string,
  score: number
): Promise<BattleParticipant> {
  const battle = await battleRepository.findByIdAndTenant(battleId, tenantId);

  if (!battle) {
    throw new Error('バトルが見つかりません');
  }

  if (battle.status !== BattleStatus.IN_PROGRESS) {
    throw new Error('進行中のバトルでのみスコアを更新できます');
  }

  const participant = await battleRepository.getParticipant(battleId, userId);

  if (!participant) {
    throw new Error('参加者が見つかりません');
  }

  const updated = await battleRepository.updateParticipant(battleId, userId, {
    score,
  });

  await battleRepository.addHistory(battleId, 'SCORE_UPDATED', {
    userId,
    score,
  });

  return updated;
}
