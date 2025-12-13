import { BattleStatus, type BattleMode, type Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';

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
  status?: BattleStatus;
}

export interface UpdateBattleInput {
  title?: string;
  description?: string;
  maxParticipants?: number;
  timeLimit?: number;
}

export async function createBattle(input: CreateBattleInput) {
  return prisma.battle.create({
    data: input,
  });
}

export async function getBattle(battleId: string, tenantId: string) {
  const battle = await prisma.battle.findUnique({
    where: { id: battleId },
    include: { participants: true, teams: true },
  });

  if (!battle || battle.tenantId !== tenantId) {
    return null;
  }

  return battle;
}

export async function listBattles(
  tenantId: string,
  options: ListBattlesOptions
) {
  const { page, limit, status } = options;
  const skip = (page - 1) * limit;

  const where: Prisma.BattleWhereInput = { tenantId };
  if (status) {
    where.status = status;
  }

  const [data, total] = await Promise.all([
    prisma.battle.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: { participants: true },
    }),
    prisma.battle.count({ where }),
  ]);

  return { data, total, page, limit };
}

export async function updateBattle(
  battleId: string,
  tenantId: string,
  updates: UpdateBattleInput
) {
  const battle = await prisma.battle.findUnique({
    where: { id: battleId },
  });

  if (!battle || battle.tenantId !== tenantId) {
    return null;
  }

  if (battle.status === BattleStatus.IN_PROGRESS) {
    throw new Error('進行中のバトルは更新できません');
  }

  return prisma.battle.update({
    where: { id: battleId },
    data: updates,
  });
}

export async function deleteBattle(battleId: string, tenantId: string) {
  const battle = await prisma.battle.findUnique({
    where: { id: battleId },
  });

  if (!battle || battle.tenantId !== tenantId) {
    return;
  }

  if (battle.status === BattleStatus.IN_PROGRESS) {
    throw new Error('進行中のバトルは削除できません');
  }

  await prisma.battle.delete({
    where: { id: battleId },
  });
}

export async function startBattle(battleId: string, tenantId: string) {
  const battle = await prisma.battle.findUnique({
    where: { id: battleId },
  });

  if (!battle || battle.tenantId !== tenantId) {
    return null;
  }

  if (battle.status !== BattleStatus.WAITING) {
    throw new Error('待機中のバトルのみ開始できます');
  }

  const participantCount = await prisma.battleParticipant.count({
    where: { battleId, leftAt: null },
  });

  if (participantCount === 0) {
    throw new Error('参加者がいないためバトルを開始できません');
  }

  const updatedBattle = await prisma.battle.update({
    where: { id: battleId },
    data: {
      status: BattleStatus.IN_PROGRESS,
      startedAt: new Date(),
    },
  });

  await prisma.battleHistory.create({
    data: {
      battleId,
      eventType: 'BATTLE_STARTED',
      payload: { participantCount },
    },
  });

  return updatedBattle;
}

export async function endBattle(battleId: string, tenantId: string) {
  const battle = await prisma.battle.findUnique({
    where: { id: battleId },
  });

  if (!battle || battle.tenantId !== tenantId) {
    return null;
  }

  if (battle.status !== BattleStatus.IN_PROGRESS) {
    throw new Error('進行中でないバトルは終了できません');
  }

  const updatedBattle = await prisma.battle.update({
    where: { id: battleId },
    data: {
      status: BattleStatus.FINISHED,
      endedAt: new Date(),
    },
  });

  await prisma.battleHistory.create({
    data: {
      battleId,
      eventType: 'BATTLE_ENDED',
      payload: {},
    },
  });

  return updatedBattle;
}

export async function joinBattle(
  battleId: string,
  tenantId: string,
  userId: string,
  teamId?: string
) {
  const battle = await prisma.battle.findUnique({
    where: { id: battleId },
  });

  if (!battle || battle.tenantId !== tenantId) {
    throw new Error('バトルが見つかりません');
  }

  if (battle.status !== BattleStatus.WAITING) {
    throw new Error('待機中のバトルにのみ参加できます');
  }

  const currentCount = await prisma.battleParticipant.count({
    where: { battleId, leftAt: null },
  });

  if (currentCount >= battle.maxParticipants) {
    throw new Error('バトルの定員に達しています');
  }

  const existing = await prisma.battleParticipant.findUnique({
    where: { battleId_userId: { battleId, userId } },
  });

  if (existing && !existing.leftAt) {
    throw new Error('既にこのバトルに参加しています');
  }

  return prisma.battleParticipant.create({
    data: {
      battleId,
      userId,
      teamId,
    },
  });
}

export async function leaveBattle(
  battleId: string,
  tenantId: string,
  userId: string
) {
  const battle = await prisma.battle.findUnique({
    where: { id: battleId },
  });

  if (!battle || battle.tenantId !== tenantId) {
    throw new Error('バトルが見つかりません');
  }

  if (battle.status === BattleStatus.IN_PROGRESS) {
    throw new Error('進行中のバトルからは退出できません');
  }

  const participant = await prisma.battleParticipant.findUnique({
    where: { battleId_userId: { battleId, userId } },
  });

  if (!participant) {
    throw new Error('参加者が見つかりません');
  }

  await prisma.battleParticipant.update({
    where: { battleId_userId: { battleId, userId } },
    data: { leftAt: new Date() },
  });
}

export async function updateScore(
  battleId: string,
  tenantId: string,
  userId: string,
  score: number
) {
  const battle = await prisma.battle.findUnique({
    where: { id: battleId },
  });

  if (!battle || battle.tenantId !== tenantId) {
    throw new Error('バトルが見つかりません');
  }

  if (battle.status !== BattleStatus.IN_PROGRESS) {
    throw new Error('進行中のバトルでのみスコアを更新できます');
  }

  const participant = await prisma.battleParticipant.findUnique({
    where: { battleId_userId: { battleId, userId } },
  });

  if (!participant) {
    throw new Error('参加者が見つかりません');
  }

  const updated = await prisma.battleParticipant.update({
    where: { battleId_userId: { battleId, userId } },
    data: { score },
  });

  await prisma.battleHistory.create({
    data: {
      battleId,
      eventType: 'SCORE_UPDATED',
      payload: { userId, score },
    },
  });

  return updated;
}
