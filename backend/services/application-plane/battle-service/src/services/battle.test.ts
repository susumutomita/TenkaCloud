import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BattleStatus, BattleMode } from '@tenkacloud/dynamodb';

// vi.hoisted を使用してモックをホイスト
const { mockBattleRepository } = vi.hoisted(() => ({
  mockBattleRepository: {
    create: vi.fn(),
    findById: vi.fn(),
    findByIdAndTenant: vi.fn(),
    listByTenant: vi.fn(),
    countByTenant: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    addParticipant: vi.fn(),
    getParticipant: vi.fn(),
    listParticipants: vi.fn(),
    countActiveParticipants: vi.fn(),
    updateParticipant: vi.fn(),
    addHistory: vi.fn(),
  },
}));

vi.mock('../lib/dynamodb', () => ({
  battleRepository: mockBattleRepository,
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
        startedAt: undefined,
        endedAt: undefined,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockBattleRepository.create.mockResolvedValue(expectedBattle);

      const result = await createBattle(input);

      expect(result).toEqual(expectedBattle);
      expect(mockBattleRepository.create).toHaveBeenCalledWith({
        tenantId: input.tenantId,
        title: input.title,
        description: input.description,
        mode: input.mode,
        maxParticipants: input.maxParticipants,
        timeLimit: input.timeLimit,
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
        description: undefined,
        status: BattleStatus.WAITING,
        startedAt: undefined,
        endedAt: undefined,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockBattleRepository.create.mockResolvedValue(expectedBattle);

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
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockBattleRepository.findByIdAndTenant.mockResolvedValue(expectedBattle);
      mockBattleRepository.listParticipants.mockResolvedValue([]);

      const result = await getBattle(battleId, tenantId);

      expect(result).toEqual({ ...expectedBattle, participants: [] });
      expect(mockBattleRepository.findByIdAndTenant).toHaveBeenCalledWith(
        battleId,
        tenantId
      );
    });

    it('存在しないバトルの場合はnullを返すべき', async () => {
      mockBattleRepository.findByIdAndTenant.mockResolvedValue(null);

      const result = await getBattle('non-existent', 'tenant-1');

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

      mockBattleRepository.listByTenant.mockResolvedValue({
        battles: expectedBattles,
      });
      mockBattleRepository.countByTenant.mockResolvedValue(2);

      const result = await listBattles(tenantId, { page: 1, limit: 10 });

      expect(result.data).toEqual(expectedBattles);
      expect(result.total).toBe(2);
    });

    it('ステータスでフィルタできるべき', async () => {
      const tenantId = 'tenant-1';
      mockBattleRepository.listByTenant.mockResolvedValue({ battles: [] });
      mockBattleRepository.countByTenant.mockResolvedValue(0);

      await listBattles(tenantId, {
        page: 1,
        limit: 10,
        status: BattleStatus.IN_PROGRESS,
      });

      expect(mockBattleRepository.listByTenant).toHaveBeenCalledWith(tenantId, {
        status: BattleStatus.IN_PROGRESS,
        limit: 10,
      });
    });
  });

  describe('updateBattle', () => {
    it('バトル情報を更新できるべき', async () => {
      const battleId = 'battle-1';
      const tenantId = 'tenant-1';
      const updates = { title: '更新されたタイトル' };

      mockBattleRepository.findByIdAndTenant.mockResolvedValue({
        id: battleId,
        tenantId,
        status: BattleStatus.WAITING,
      });
      mockBattleRepository.update.mockResolvedValue({
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

      mockBattleRepository.findByIdAndTenant.mockResolvedValue({
        id: battleId,
        tenantId,
        status: BattleStatus.IN_PROGRESS,
      });

      await expect(
        updateBattle(battleId, tenantId, { title: '新タイトル' })
      ).rejects.toThrow('進行中のバトルは更新できません');
    });

    it('バトルが見つからない場合はnullを返すべき', async () => {
      mockBattleRepository.findByIdAndTenant.mockResolvedValue(null);

      const result = await updateBattle('non-existent', 'tenant-1', {
        title: '新タイトル',
      });

      expect(result).toBeNull();
    });
  });

  describe('deleteBattle', () => {
    it('バトルを削除できるべき', async () => {
      const battleId = 'battle-1';
      const tenantId = 'tenant-1';

      mockBattleRepository.findByIdAndTenant.mockResolvedValue({
        id: battleId,
        tenantId,
        status: BattleStatus.WAITING,
      });
      mockBattleRepository.delete.mockResolvedValue(undefined);

      await deleteBattle(battleId, tenantId);

      expect(mockBattleRepository.delete).toHaveBeenCalledWith(battleId);
    });

    it('進行中のバトルは削除できないべき', async () => {
      mockBattleRepository.findByIdAndTenant.mockResolvedValue({
        id: 'battle-1',
        tenantId: 'tenant-1',
        status: BattleStatus.IN_PROGRESS,
      });

      await expect(deleteBattle('battle-1', 'tenant-1')).rejects.toThrow(
        '進行中のバトルは削除できません'
      );
    });

    it('バトルが見つからない場合は何もしないべき', async () => {
      mockBattleRepository.findByIdAndTenant.mockResolvedValue(null);

      await deleteBattle('non-existent', 'tenant-1');

      expect(mockBattleRepository.delete).not.toHaveBeenCalled();
    });
  });

  describe('startBattle', () => {
    it('バトルを開始できるべき', async () => {
      const battleId = 'battle-1';
      const tenantId = 'tenant-1';
      const now = new Date();

      mockBattleRepository.findByIdAndTenant.mockResolvedValue({
        id: battleId,
        tenantId,
        status: BattleStatus.WAITING,
      });
      mockBattleRepository.countActiveParticipants.mockResolvedValue(2);
      mockBattleRepository.update.mockResolvedValue({
        id: battleId,
        status: BattleStatus.IN_PROGRESS,
        startedAt: now,
      });
      mockBattleRepository.addHistory.mockResolvedValue({});

      const result = await startBattle(battleId, tenantId);

      expect(result?.status).toBe(BattleStatus.IN_PROGRESS);
      expect(mockBattleRepository.addHistory).toHaveBeenCalledWith(
        battleId,
        'BATTLE_STARTED',
        { participantCount: 2 }
      );
    });

    it('参加者がいないバトルは開始できないべき', async () => {
      mockBattleRepository.findByIdAndTenant.mockResolvedValue({
        id: 'battle-1',
        tenantId: 'tenant-1',
        status: BattleStatus.WAITING,
      });
      mockBattleRepository.countActiveParticipants.mockResolvedValue(0);

      await expect(startBattle('battle-1', 'tenant-1')).rejects.toThrow(
        '参加者がいないためバトルを開始できません'
      );
    });

    it('待機中以外のバトルは開始できないべき', async () => {
      mockBattleRepository.findByIdAndTenant.mockResolvedValue({
        id: 'battle-1',
        tenantId: 'tenant-1',
        status: BattleStatus.IN_PROGRESS,
      });

      await expect(startBattle('battle-1', 'tenant-1')).rejects.toThrow(
        '待機中のバトルのみ開始できます'
      );
    });

    it('バトルが見つからない場合はnullを返すべき', async () => {
      mockBattleRepository.findByIdAndTenant.mockResolvedValue(null);

      const result = await startBattle('non-existent', 'tenant-1');

      expect(result).toBeNull();
    });
  });

  describe('endBattle', () => {
    it('バトルを終了できるべき', async () => {
      const battleId = 'battle-1';
      const tenantId = 'tenant-1';

      mockBattleRepository.findByIdAndTenant.mockResolvedValue({
        id: battleId,
        tenantId,
        status: BattleStatus.IN_PROGRESS,
      });
      mockBattleRepository.update.mockResolvedValue({
        id: battleId,
        status: BattleStatus.FINISHED,
        endedAt: new Date(),
      });
      mockBattleRepository.addHistory.mockResolvedValue({});

      const result = await endBattle(battleId, tenantId);

      expect(result?.status).toBe(BattleStatus.FINISHED);
    });

    it('待機中のバトルは終了できないべき', async () => {
      mockBattleRepository.findByIdAndTenant.mockResolvedValue({
        id: 'battle-1',
        tenantId: 'tenant-1',
        status: BattleStatus.WAITING,
      });

      await expect(endBattle('battle-1', 'tenant-1')).rejects.toThrow(
        '進行中でないバトルは終了できません'
      );
    });

    it('バトルが見つからない場合はnullを返すべき', async () => {
      mockBattleRepository.findByIdAndTenant.mockResolvedValue(null);

      const result = await endBattle('non-existent', 'tenant-1');

      expect(result).toBeNull();
    });
  });

  describe('joinBattle', () => {
    it('バトルに参加できるべき', async () => {
      const battleId = 'battle-1';
      const tenantId = 'tenant-1';
      const userId = 'user-1';

      mockBattleRepository.findByIdAndTenant.mockResolvedValue({
        id: battleId,
        tenantId,
        status: BattleStatus.WAITING,
        maxParticipants: 10,
      });
      mockBattleRepository.countActiveParticipants.mockResolvedValue(5);
      mockBattleRepository.getParticipant.mockResolvedValue(null);
      mockBattleRepository.addParticipant.mockResolvedValue({
        id: 'participant-1',
        battleId,
        userId,
        score: 0,
      });

      const result = await joinBattle(battleId, tenantId, userId);

      expect(result.userId).toBe(userId);
    });

    it('定員に達したバトルには参加できないべき', async () => {
      mockBattleRepository.findByIdAndTenant.mockResolvedValue({
        id: 'battle-1',
        tenantId: 'tenant-1',
        status: BattleStatus.WAITING,
        maxParticipants: 10,
      });
      mockBattleRepository.countActiveParticipants.mockResolvedValue(10);

      await expect(
        joinBattle('battle-1', 'tenant-1', 'user-1')
      ).rejects.toThrow('バトルの定員に達しています');
    });

    it('既に参加しているユーザーは重複参加できないべき', async () => {
      mockBattleRepository.findByIdAndTenant.mockResolvedValue({
        id: 'battle-1',
        tenantId: 'tenant-1',
        status: BattleStatus.WAITING,
        maxParticipants: 10,
      });
      mockBattleRepository.countActiveParticipants.mockResolvedValue(5);
      mockBattleRepository.getParticipant.mockResolvedValue({
        id: 'participant-1',
        leftAt: undefined,
      });

      await expect(
        joinBattle('battle-1', 'tenant-1', 'user-1')
      ).rejects.toThrow('既にこのバトルに参加しています');
    });

    it('バトルが見つからない場合はエラーを投げるべき', async () => {
      mockBattleRepository.findByIdAndTenant.mockResolvedValue(null);

      await expect(
        joinBattle('battle-1', 'tenant-1', 'user-1')
      ).rejects.toThrow('バトルが見つかりません');
    });

    it('待機中以外のバトルには参加できないべき', async () => {
      mockBattleRepository.findByIdAndTenant.mockResolvedValue({
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

  describe('leaveBattle', () => {
    it('バトルから退出できるべき', async () => {
      const battleId = 'battle-1';
      const tenantId = 'tenant-1';
      const userId = 'user-1';

      mockBattleRepository.findByIdAndTenant.mockResolvedValue({
        id: battleId,
        tenantId,
        status: BattleStatus.WAITING,
      });
      mockBattleRepository.getParticipant.mockResolvedValue({
        id: 'participant-1',
        battleId,
        userId,
      });
      mockBattleRepository.updateParticipant.mockResolvedValue({
        id: 'participant-1',
        leftAt: new Date(),
      });

      await leaveBattle(battleId, tenantId, userId);

      expect(mockBattleRepository.updateParticipant).toHaveBeenCalledWith(
        battleId,
        userId,
        { leftAt: expect.any(Date) }
      );
    });

    it('進行中のバトルからは退出できないべき', async () => {
      mockBattleRepository.findByIdAndTenant.mockResolvedValue({
        id: 'battle-1',
        tenantId: 'tenant-1',
        status: BattleStatus.IN_PROGRESS,
      });

      await expect(
        leaveBattle('battle-1', 'tenant-1', 'user-1')
      ).rejects.toThrow('進行中のバトルからは退出できません');
    });

    it('バトルが見つからない場合はエラーを投げるべき', async () => {
      mockBattleRepository.findByIdAndTenant.mockResolvedValue(null);

      await expect(
        leaveBattle('battle-1', 'tenant-1', 'user-1')
      ).rejects.toThrow('バトルが見つかりません');
    });

    it('参加者が見つからない場合はエラーを投げるべき', async () => {
      mockBattleRepository.findByIdAndTenant.mockResolvedValue({
        id: 'battle-1',
        tenantId: 'tenant-1',
        status: BattleStatus.WAITING,
      });
      mockBattleRepository.getParticipant.mockResolvedValue(null);

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

      mockBattleRepository.findByIdAndTenant.mockResolvedValue({
        id: battleId,
        tenantId,
        status: BattleStatus.IN_PROGRESS,
      });
      mockBattleRepository.getParticipant.mockResolvedValue({
        id: 'participant-1',
        battleId,
        userId,
        score: 0,
      });
      mockBattleRepository.updateParticipant.mockResolvedValue({
        id: 'participant-1',
        score,
      });
      mockBattleRepository.addHistory.mockResolvedValue({});

      const result = await updateScore(battleId, tenantId, userId, score);

      expect(result.score).toBe(score);
      expect(mockBattleRepository.addHistory).toHaveBeenCalledWith(
        battleId,
        'SCORE_UPDATED',
        { userId, score }
      );
    });

    it('進行中でないバトルのスコアは更新できないべき', async () => {
      mockBattleRepository.findByIdAndTenant.mockResolvedValue({
        id: 'battle-1',
        tenantId: 'tenant-1',
        status: BattleStatus.FINISHED,
      });

      await expect(
        updateScore('battle-1', 'tenant-1', 'user-1', 100)
      ).rejects.toThrow('進行中のバトルでのみスコアを更新できます');
    });

    it('バトルが見つからない場合はエラーを投げるべき', async () => {
      mockBattleRepository.findByIdAndTenant.mockResolvedValue(null);

      await expect(
        updateScore('battle-1', 'tenant-1', 'user-1', 100)
      ).rejects.toThrow('バトルが見つかりません');
    });

    it('参加者が見つからない場合はエラーを投げるべき', async () => {
      mockBattleRepository.findByIdAndTenant.mockResolvedValue({
        id: 'battle-1',
        tenantId: 'tenant-1',
        status: BattleStatus.IN_PROGRESS,
      });
      mockBattleRepository.getParticipant.mockResolvedValue(null);

      await expect(
        updateScore('battle-1', 'tenant-1', 'user-1', 100)
      ).rejects.toThrow('参加者が見つかりません');
    });
  });
});
