import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BattleStatus, BattleMode } from '@prisma/client';

// vi.hoisted を使用してモックをホイスト
const { mockBattle, mockBattleParticipant, mockBattleHistory } = vi.hoisted(
  () => ({
    mockBattle: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
    },
    mockBattleParticipant: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
    },
    mockBattleHistory: {
      create: vi.fn(),
    },
  })
);

vi.mock('../lib/prisma', () => ({
  prisma: {
    battle: mockBattle,
    battleParticipant: mockBattleParticipant,
    battleHistory: mockBattleHistory,
  },
}));

// サービス関数のインポートはモック後に行う
import {
  createBattle,
  getBattle,
  listBattles,
  updateBattle,
  deleteBattle,
  startBattle,
  endBattle,
  joinBattle,
  leaveBattle,
  updateScore,
} from './battle';

describe('バトル管理サービス', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createBattle', () => {
    it('新しいバトルを作成できるべき', async () => {
      const input = {
        tenantId: 'tenant-1',
        title: 'テストバトル',
        description: 'テスト説明',
        mode: BattleMode.INDIVIDUAL,
        maxParticipants: 10,
        timeLimit: 3600,
      };

      const expectedBattle = {
        id: 'battle-1',
        ...input,
        status: BattleStatus.WAITING,
        startedAt: null,
        endedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockBattle.create.mockResolvedValue(expectedBattle);

      const result = await createBattle(input);

      expect(result).toEqual(expectedBattle);
      expect(mockBattle.create).toHaveBeenCalledWith({
        data: input,
      });
    });

    it('チームモードでバトルを作成できるべき', async () => {
      const input = {
        tenantId: 'tenant-1',
        title: 'チームバトル',
        mode: BattleMode.TEAM,
        maxParticipants: 20,
        timeLimit: 7200,
      };

      const expectedBattle = {
        id: 'battle-2',
        ...input,
        description: null,
        status: BattleStatus.WAITING,
        startedAt: null,
        endedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockBattle.create.mockResolvedValue(expectedBattle);

      const result = await createBattle(input);

      expect(result.mode).toBe(BattleMode.TEAM);
    });
  });

  describe('getBattle', () => {
    it('IDでバトルを取得できるべき', async () => {
      const battleId = 'battle-1';
      const tenantId = 'tenant-1';
      const expectedBattle = {
        id: battleId,
        tenantId,
        title: 'テストバトル',
        status: BattleStatus.WAITING,
        participants: [],
        teams: [],
      };

      mockBattle.findUnique.mockResolvedValue(expectedBattle);

      const result = await getBattle(battleId, tenantId);

      expect(result).toEqual(expectedBattle);
      expect(mockBattle.findUnique).toHaveBeenCalledWith({
        where: { id: battleId },
        include: { participants: true, teams: true },
      });
    });

    it('存在しないバトルの場合はnullを返すべき', async () => {
      mockBattle.findUnique.mockResolvedValue(null);

      const result = await getBattle('non-existent', 'tenant-1');

      expect(result).toBeNull();
    });

    it('テナントIDが一致しない場合はnullを返すべき', async () => {
      mockBattle.findUnique.mockResolvedValue({
        id: 'battle-1',
        tenantId: 'other-tenant',
      });

      const result = await getBattle('battle-1', 'tenant-1');

      expect(result).toBeNull();
    });
  });

  describe('listBattles', () => {
    it('テナントのバトル一覧を取得できるべき', async () => {
      const tenantId = 'tenant-1';
      const expectedBattles = [
        { id: 'battle-1', tenantId, title: 'バトル1' },
        { id: 'battle-2', tenantId, title: 'バトル2' },
      ];

      mockBattle.findMany.mockResolvedValue(expectedBattles);
      mockBattle.count.mockResolvedValue(2);

      const result = await listBattles(tenantId, { page: 1, limit: 10 });

      expect(result.data).toEqual(expectedBattles);
      expect(result.total).toBe(2);
    });

    it('ステータスでフィルタできるべき', async () => {
      const tenantId = 'tenant-1';
      mockBattle.findMany.mockResolvedValue([]);
      mockBattle.count.mockResolvedValue(0);

      await listBattles(tenantId, {
        page: 1,
        limit: 10,
        status: BattleStatus.IN_PROGRESS,
      });

      expect(mockBattle.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tenantId, status: BattleStatus.IN_PROGRESS },
        })
      );
    });
  });

  describe('updateBattle', () => {
    it('バトル情報を更新できるべき', async () => {
      const battleId = 'battle-1';
      const tenantId = 'tenant-1';
      const updates = { title: '更新されたタイトル' };

      mockBattle.findUnique.mockResolvedValue({
        id: battleId,
        tenantId,
        status: BattleStatus.WAITING,
      });
      mockBattle.update.mockResolvedValue({
        id: battleId,
        tenantId,
        title: '更新されたタイトル',
      });

      const result = await updateBattle(battleId, tenantId, updates);

      expect(result?.title).toBe('更新されたタイトル');
    });

    it('進行中のバトルは更新できないべき', async () => {
      const battleId = 'battle-1';
      const tenantId = 'tenant-1';

      mockBattle.findUnique.mockResolvedValue({
        id: battleId,
        tenantId,
        status: BattleStatus.IN_PROGRESS,
      });

      await expect(
        updateBattle(battleId, tenantId, { title: '新タイトル' })
      ).rejects.toThrow('進行中のバトルは更新できません');
    });

    it('バトルが見つからない場合はnullを返すべき', async () => {
      mockBattle.findUnique.mockResolvedValue(null);

      const result = await updateBattle('non-existent', 'tenant-1', {
        title: '新タイトル',
      });

      expect(result).toBeNull();
    });

    it('テナントIDが一致しない場合はnullを返すべき', async () => {
      mockBattle.findUnique.mockResolvedValue({
        id: 'battle-1',
        tenantId: 'other-tenant',
        status: BattleStatus.WAITING,
      });

      const result = await updateBattle('battle-1', 'tenant-1', {
        title: '新タイトル',
      });

      expect(result).toBeNull();
    });
  });

  describe('deleteBattle', () => {
    it('バトルを削除できるべき', async () => {
      const battleId = 'battle-1';
      const tenantId = 'tenant-1';

      mockBattle.findUnique.mockResolvedValue({
        id: battleId,
        tenantId,
        status: BattleStatus.WAITING,
      });
      mockBattle.delete.mockResolvedValue({ id: battleId });

      await deleteBattle(battleId, tenantId);

      expect(mockBattle.delete).toHaveBeenCalledWith({
        where: { id: battleId },
      });
    });

    it('進行中のバトルは削除できないべき', async () => {
      mockBattle.findUnique.mockResolvedValue({
        id: 'battle-1',
        tenantId: 'tenant-1',
        status: BattleStatus.IN_PROGRESS,
      });

      await expect(deleteBattle('battle-1', 'tenant-1')).rejects.toThrow(
        '進行中のバトルは削除できません'
      );
    });

    it('バトルが見つからない場合は何もしないべき', async () => {
      mockBattle.findUnique.mockResolvedValue(null);

      await deleteBattle('non-existent', 'tenant-1');

      expect(mockBattle.delete).not.toHaveBeenCalled();
    });

    it('テナントIDが一致しない場合は何もしないべき', async () => {
      mockBattle.findUnique.mockResolvedValue({
        id: 'battle-1',
        tenantId: 'other-tenant',
        status: BattleStatus.WAITING,
      });

      await deleteBattle('battle-1', 'tenant-1');

      expect(mockBattle.delete).not.toHaveBeenCalled();
    });
  });

  describe('startBattle', () => {
    it('バトルを開始できるべき', async () => {
      const battleId = 'battle-1';
      const tenantId = 'tenant-1';
      const now = new Date();

      mockBattle.findUnique.mockResolvedValue({
        id: battleId,
        tenantId,
        status: BattleStatus.WAITING,
      });
      mockBattleParticipant.count.mockResolvedValue(2);
      mockBattle.update.mockResolvedValue({
        id: battleId,
        status: BattleStatus.IN_PROGRESS,
        startedAt: now,
      });

      const result = await startBattle(battleId, tenantId);

      expect(result?.status).toBe(BattleStatus.IN_PROGRESS);
      expect(mockBattleHistory.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          battleId,
          eventType: 'BATTLE_STARTED',
        }),
      });
    });

    it('参加者がいないバトルは開始できないべき', async () => {
      mockBattle.findUnique.mockResolvedValue({
        id: 'battle-1',
        tenantId: 'tenant-1',
        status: BattleStatus.WAITING,
      });
      mockBattleParticipant.count.mockResolvedValue(0);

      await expect(startBattle('battle-1', 'tenant-1')).rejects.toThrow(
        '参加者がいないためバトルを開始できません'
      );
    });
  });

  describe('endBattle', () => {
    it('バトルを終了できるべき', async () => {
      const battleId = 'battle-1';
      const tenantId = 'tenant-1';

      mockBattle.findUnique.mockResolvedValue({
        id: battleId,
        tenantId,
        status: BattleStatus.IN_PROGRESS,
      });
      mockBattle.update.mockResolvedValue({
        id: battleId,
        status: BattleStatus.FINISHED,
        endedAt: new Date(),
      });

      const result = await endBattle(battleId, tenantId);

      expect(result?.status).toBe(BattleStatus.FINISHED);
    });

    it('待機中のバトルは終了できないべき', async () => {
      mockBattle.findUnique.mockResolvedValue({
        id: 'battle-1',
        tenantId: 'tenant-1',
        status: BattleStatus.WAITING,
      });

      await expect(endBattle('battle-1', 'tenant-1')).rejects.toThrow(
        '進行中でないバトルは終了できません'
      );
    });
  });

  describe('joinBattle', () => {
    it('バトルに参加できるべき', async () => {
      const battleId = 'battle-1';
      const tenantId = 'tenant-1';
      const userId = 'user-1';

      mockBattle.findUnique.mockResolvedValue({
        id: battleId,
        tenantId,
        status: BattleStatus.WAITING,
        maxParticipants: 10,
      });
      mockBattleParticipant.count.mockResolvedValue(5);
      mockBattleParticipant.findUnique.mockResolvedValue(null);
      mockBattleParticipant.create.mockResolvedValue({
        id: 'participant-1',
        battleId,
        userId,
        score: 0,
      });

      const result = await joinBattle(battleId, tenantId, userId);

      expect(result.userId).toBe(userId);
    });

    it('定員に達したバトルには参加できないべき', async () => {
      mockBattle.findUnique.mockResolvedValue({
        id: 'battle-1',
        tenantId: 'tenant-1',
        status: BattleStatus.WAITING,
        maxParticipants: 10,
      });
      mockBattleParticipant.count.mockResolvedValue(10);

      await expect(
        joinBattle('battle-1', 'tenant-1', 'user-1')
      ).rejects.toThrow('バトルの定員に達しています');
    });

    it('既に参加しているユーザーは重複参加できないべき', async () => {
      mockBattle.findUnique.mockResolvedValue({
        id: 'battle-1',
        tenantId: 'tenant-1',
        status: BattleStatus.WAITING,
        maxParticipants: 10,
      });
      mockBattleParticipant.count.mockResolvedValue(5);
      mockBattleParticipant.findUnique.mockResolvedValue({
        id: 'participant-1',
      });

      await expect(
        joinBattle('battle-1', 'tenant-1', 'user-1')
      ).rejects.toThrow('既にこのバトルに参加しています');
    });
  });

  describe('leaveBattle', () => {
    it('バトルから退出できるべき', async () => {
      const battleId = 'battle-1';
      const tenantId = 'tenant-1';
      const userId = 'user-1';

      mockBattle.findUnique.mockResolvedValue({
        id: battleId,
        tenantId,
        status: BattleStatus.WAITING,
      });
      mockBattleParticipant.findUnique.mockResolvedValue({
        id: 'participant-1',
        battleId,
        userId,
      });
      mockBattleParticipant.update.mockResolvedValue({
        id: 'participant-1',
        leftAt: new Date(),
      });

      await leaveBattle(battleId, tenantId, userId);

      expect(mockBattleParticipant.update).toHaveBeenCalledWith({
        where: { battleId_userId: { battleId, userId } },
        data: { leftAt: expect.any(Date) },
      });
    });

    it('進行中のバトルからは退出できないべき', async () => {
      mockBattle.findUnique.mockResolvedValue({
        id: 'battle-1',
        tenantId: 'tenant-1',
        status: BattleStatus.IN_PROGRESS,
      });

      await expect(
        leaveBattle('battle-1', 'tenant-1', 'user-1')
      ).rejects.toThrow('進行中のバトルからは退出できません');
    });

    it('バトルが見つからない場合はエラーを投げるべき', async () => {
      mockBattle.findUnique.mockResolvedValue(null);

      await expect(
        leaveBattle('battle-1', 'tenant-1', 'user-1')
      ).rejects.toThrow('バトルが見つかりません');
    });

    it('参加者が見つからない場合はエラーを投げるべき', async () => {
      mockBattle.findUnique.mockResolvedValue({
        id: 'battle-1',
        tenantId: 'tenant-1',
        status: BattleStatus.WAITING,
      });
      mockBattleParticipant.findUnique.mockResolvedValue(null);

      await expect(
        leaveBattle('battle-1', 'tenant-1', 'user-1')
      ).rejects.toThrow('参加者が見つかりません');
    });
  });

  describe('updateScore', () => {
    it('参加者のスコアを更新できるべき', async () => {
      const battleId = 'battle-1';
      const tenantId = 'tenant-1';
      const userId = 'user-1';
      const score = 100;

      mockBattle.findUnique.mockResolvedValue({
        id: battleId,
        tenantId,
        status: BattleStatus.IN_PROGRESS,
      });
      mockBattleParticipant.findUnique.mockResolvedValue({
        id: 'participant-1',
        battleId,
        userId,
        score: 0,
      });
      mockBattleParticipant.update.mockResolvedValue({
        id: 'participant-1',
        score,
      });

      const result = await updateScore(battleId, tenantId, userId, score);

      expect(result.score).toBe(score);
      expect(mockBattleHistory.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          battleId,
          eventType: 'SCORE_UPDATED',
          payload: { userId, score },
        }),
      });
    });

    it('進行中でないバトルのスコアは更新できないべき', async () => {
      mockBattle.findUnique.mockResolvedValue({
        id: 'battle-1',
        tenantId: 'tenant-1',
        status: BattleStatus.FINISHED,
      });

      await expect(
        updateScore('battle-1', 'tenant-1', 'user-1', 100)
      ).rejects.toThrow('進行中のバトルでのみスコアを更新できます');
    });

    it('バトルが見つからない場合はエラーを投げるべき', async () => {
      mockBattle.findUnique.mockResolvedValue(null);

      await expect(
        updateScore('battle-1', 'tenant-1', 'user-1', 100)
      ).rejects.toThrow('バトルが見つかりません');
    });

    it('参加者が見つからない場合はエラーを投げるべき', async () => {
      mockBattle.findUnique.mockResolvedValue({
        id: 'battle-1',
        tenantId: 'tenant-1',
        status: BattleStatus.IN_PROGRESS,
      });
      mockBattleParticipant.findUnique.mockResolvedValue(null);

      await expect(
        updateScore('battle-1', 'tenant-1', 'user-1', 100)
      ).rejects.toThrow('参加者が見つかりません');
    });
  });

  describe('joinBattle - 追加ケース', () => {
    it('バトルが見つからない場合はエラーを投げるべき', async () => {
      mockBattle.findUnique.mockResolvedValue(null);

      await expect(
        joinBattle('battle-1', 'tenant-1', 'user-1')
      ).rejects.toThrow('バトルが見つかりません');
    });

    it('待機中以外のバトルには参加できないべき', async () => {
      mockBattle.findUnique.mockResolvedValue({
        id: 'battle-1',
        tenantId: 'tenant-1',
        status: BattleStatus.IN_PROGRESS,
        maxParticipants: 10,
      });

      await expect(
        joinBattle('battle-1', 'tenant-1', 'user-1')
      ).rejects.toThrow('待機中のバトルにのみ参加できます');
    });
  });

  describe('startBattle - 追加ケース', () => {
    it('待機中以外のバトルは開始できないべき', async () => {
      mockBattle.findUnique.mockResolvedValue({
        id: 'battle-1',
        tenantId: 'tenant-1',
        status: BattleStatus.IN_PROGRESS,
      });

      await expect(startBattle('battle-1', 'tenant-1')).rejects.toThrow(
        '待機中のバトルのみ開始できます'
      );
    });

    it('バトルが見つからない場合はnullを返すべき', async () => {
      mockBattle.findUnique.mockResolvedValue(null);

      const result = await startBattle('non-existent', 'tenant-1');

      expect(result).toBeNull();
    });

    it('テナントIDが一致しない場合はnullを返すべき', async () => {
      mockBattle.findUnique.mockResolvedValue({
        id: 'battle-1',
        tenantId: 'other-tenant',
        status: BattleStatus.WAITING,
      });

      const result = await startBattle('battle-1', 'tenant-1');

      expect(result).toBeNull();
    });
  });

  describe('endBattle - 追加ケース', () => {
    it('バトルが見つからない場合はnullを返すべき', async () => {
      mockBattle.findUnique.mockResolvedValue(null);

      const result = await endBattle('non-existent', 'tenant-1');

      expect(result).toBeNull();
    });

    it('テナントIDが一致しない場合はnullを返すべき', async () => {
      mockBattle.findUnique.mockResolvedValue({
        id: 'battle-1',
        tenantId: 'other-tenant',
        status: BattleStatus.IN_PROGRESS,
      });

      const result = await endBattle('battle-1', 'tenant-1');

      expect(result).toBeNull();
    });
  });

  describe('joinBattle - テナント不一致ケース', () => {
    it('テナントIDが一致しない場合はエラーを投げるべき', async () => {
      mockBattle.findUnique.mockResolvedValue({
        id: 'battle-1',
        tenantId: 'other-tenant',
        status: BattleStatus.WAITING,
        maxParticipants: 10,
      });

      await expect(
        joinBattle('battle-1', 'tenant-1', 'user-1')
      ).rejects.toThrow('バトルが見つかりません');
    });
  });

  describe('leaveBattle - テナント不一致ケース', () => {
    it('テナントIDが一致しない場合はエラーを投げるべき', async () => {
      mockBattle.findUnique.mockResolvedValue({
        id: 'battle-1',
        tenantId: 'other-tenant',
        status: BattleStatus.WAITING,
      });

      await expect(
        leaveBattle('battle-1', 'tenant-1', 'user-1')
      ).rejects.toThrow('バトルが見つかりません');
    });
  });

  describe('updateScore - テナント不一致ケース', () => {
    it('テナントIDが一致しない場合はエラーを投げるべき', async () => {
      mockBattle.findUnique.mockResolvedValue({
        id: 'battle-1',
        tenantId: 'other-tenant',
        status: BattleStatus.IN_PROGRESS,
      });

      await expect(
        updateScore('battle-1', 'tenant-1', 'user-1', 100)
      ).rejects.toThrow('バトルが見つかりません');
    });
  });
});
