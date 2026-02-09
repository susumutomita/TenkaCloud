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

// 有効な状態遷移マップ
const validTransitions: Record<string, string[]> = {
  [BattleStatus.DRAFT]: [BattleStatus.OPEN],
  [BattleStatus.OPEN]: [BattleStatus.RUNNING],
  [BattleStatus.RUNNING]: [BattleStatus.FINISHED],
  [BattleStatus.FINISHED]: [BattleStatus.ARCHIVED],
  [BattleStatus.ARCHIVED]: [],
};

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

  if (
    battle.status === BattleStatus.RUNNING ||
    battle.status === BattleStatus.FINISHED ||
    battle.status === BattleStatus.ARCHIVED
  ) {
    throw new Error('実行中・終了済み・アーカイブ済みのバトルは更新できません');
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

  if (battle.status !== BattleStatus.DRAFT) {
    throw new Error('下書き状態のバトルのみ削除できます');
  }

  await battleRepository.delete(battleId);
}

export async function transitionBattle(
  battleId: string,
  tenantId: string,
  targetStatus: (typeof BattleStatus)[keyof typeof BattleStatus]
): Promise<Battle | null> {
  const battle = await battleRepository.findByIdAndTenant(battleId, tenantId);

  if (!battle) {
    return null;
  }

  const allowed = validTransitions[battle.status];
  if (!allowed || !allowed.includes(targetStatus)) {
    throw new Error(
      `${battle.status} から ${targetStatus} への遷移はできません`
    );
  }

  // OPEN → RUNNING: 参加者が必要
  if (targetStatus === BattleStatus.RUNNING) {
    const participantCount =
      await battleRepository.countActiveParticipants(battleId);
    if (participantCount === 0) {
      throw new Error('参加者がいないためバトルを開始できません');
    }
  }

  const updateData: Record<string, unknown> = {
    status: targetStatus,
  };

  if (targetStatus === BattleStatus.RUNNING) {
    updateData.startedAt = new Date();
  }

  if (targetStatus === BattleStatus.FINISHED) {
    updateData.endedAt = new Date();
  }

  const updatedBattle = await battleRepository.update(battleId, updateData);

  const eventTypeMap: Record<string, string> = {
    [BattleStatus.OPEN]: 'BATTLE_OPENED',
    [BattleStatus.RUNNING]: 'BATTLE_STARTED',
    [BattleStatus.FINISHED]: 'BATTLE_FINISHED',
    [BattleStatus.ARCHIVED]: 'BATTLE_ARCHIVED',
  };

  await battleRepository.addHistory(battleId, eventTypeMap[targetStatus], {
    previousStatus: battle.status,
  });

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

  if (battle.status !== BattleStatus.OPEN) {
    throw new Error('募集中のバトルにのみ参加できます');
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

  if (battle.status === BattleStatus.RUNNING) {
    throw new Error('実行中のバトルからは退出できません');
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

  if (battle.status !== BattleStatus.RUNNING) {
    throw new Error('実行中のバトルでのみスコアを更新できます');
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

export async function addProblem(
  battleId: string,
  tenantId: string,
  problemId: string
): Promise<void> {
  const battle = await battleRepository.findByIdAndTenant(battleId, tenantId);

  if (!battle) {
    throw new Error('バトルが見つかりません');
  }

  if (
    battle.status !== BattleStatus.DRAFT &&
    battle.status !== BattleStatus.OPEN
  ) {
    throw new Error('下書きまたは募集中のバトルにのみ問題を追加できます');
  }

  await battleRepository.addHistory(battleId, 'PROBLEM_ADDED', {
    problemId,
  });
}
