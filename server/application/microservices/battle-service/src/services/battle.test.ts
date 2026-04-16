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
  transitionBattle,
  joinBattle,
  leaveBattle,
  updateScore,
  addProblem,
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
        status: BattleStatus.DRAFT,
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
        status: BattleStatus.DRAFT,
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
        status: BattleStatus.DRAFT,
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
        status: BattleStatus.RUNNING,
      });

      expect(mockBattleRepository.listByTenant).toHaveBeenCalledWith(tenantId, {
        status: BattleStatus.RUNNING,
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
        status: BattleStatus.DRAFT,
      });
      mockBattleRepository.update.mockResolvedValue({
        id: battleId,
        tenantId,
        title: '更新されたタイトル',
      });

      const result = await updateBattle(battleId, tenantId, updates);

      expect(result?.title).toBe('更新されたタイトル');
    });

    it('OPEN状態のバトルも更新できるべき', async () => {
      mockBattleRepository.findByIdAndTenant.mockResolvedValue({
        id: 'battle-1',
        tenantId: 'tenant-1',
        status: BattleStatus.OPEN,
      });
      mockBattleRepository.update.mockResolvedValue({
        id: 'battle-1',
        title: '新タイトル',
      });

      const result = await updateBattle('battle-1', 'tenant-1', {
        title: '新タイトル',
      });

      expect(result?.title).toBe('新タイトル');
    });

    it('実行中のバトルは更新できないべき', async () => {
      mockBattleRepository.findByIdAndTenant.mockResolvedValue({
        id: 'battle-1',
        tenantId: 'tenant-1',
        status: BattleStatus.RUNNING,
      });

      await expect(
        updateBattle('battle-1', 'tenant-1', { title: '新タイトル' })
      ).rejects.toThrow(
        '実行中・終了済み・アーカイブ済みのバトルは更新できません'
      );
    });

    it('終了済みのバトルは更新できないべき', async () => {
      mockBattleRepository.findByIdAndTenant.mockResolvedValue({
        id: 'battle-1',
        tenantId: 'tenant-1',
        status: BattleStatus.FINISHED,
      });

      await expect(
        updateBattle('battle-1', 'tenant-1', { title: '新タイトル' })
      ).rejects.toThrow(
        '実行中・終了済み・アーカイブ済みのバトルは更新できません'
      );
    });

    it('アーカイブ済みのバトルは更新できないべき', async () => {
      mockBattleRepository.findByIdAndTenant.mockResolvedValue({
        id: 'battle-1',
        tenantId: 'tenant-1',
        status: BattleStatus.ARCHIVED,
      });

      await expect(
        updateBattle('battle-1', 'tenant-1', { title: '新タイトル' })
      ).rejects.toThrow(
        '実行中・終了済み・アーカイブ済みのバトルは更新できません'
      );
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
    it('下書き状態のバトルを削除できるべき', async () => {
      mockBattleRepository.findByIdAndTenant.mockResolvedValue({
        id: 'battle-1',
        tenantId: 'tenant-1',
        status: BattleStatus.DRAFT,
      });
      mockBattleRepository.delete.mockResolvedValue(undefined);

      await deleteBattle('battle-1', 'tenant-1');

      expect(mockBattleRepository.delete).toHaveBeenCalledWith('battle-1');
    });

    it('OPEN状態のバトルは削除できないべき', async () => {
      mockBattleRepository.findByIdAndTenant.mockResolvedValue({
        id: 'battle-1',
        tenantId: 'tenant-1',
        status: BattleStatus.OPEN,
      });

      await expect(deleteBattle('battle-1', 'tenant-1')).rejects.toThrow(
        '下書き状態のバトルのみ削除できます'
      );
    });

    it('実行中のバトルは削除できないべき', async () => {
      mockBattleRepository.findByIdAndTenant.mockResolvedValue({
        id: 'battle-1',
        tenantId: 'tenant-1',
        status: BattleStatus.RUNNING,
      });

      await expect(deleteBattle('battle-1', 'tenant-1')).rejects.toThrow(
        '下書き状態のバトルのみ削除できます'
      );
    });

    it('バトルが見つからない場合は何もしないべき', async () => {
      mockBattleRepository.findByIdAndTenant.mockResolvedValue(null);

      await deleteBattle('non-existent', 'tenant-1');

      expect(mockBattleRepository.delete).not.toHaveBeenCalled();
    });
  });

  describe('transitionBattle', () => {
    it('DRAFT → OPEN に遷移できるべき', async () => {
      mockBattleRepository.findByIdAndTenant.mockResolvedValue({
        id: 'battle-1',
        tenantId: 'tenant-1',
        status: BattleStatus.DRAFT,
      });
      mockBattleRepository.update.mockResolvedValue({
        id: 'battle-1',
        status: BattleStatus.OPEN,
      });
      mockBattleRepository.addHistory.mockResolvedValue({});

      const result = await transitionBattle(
        'battle-1',
        'tenant-1',
        BattleStatus.OPEN
      );

      expect(result?.status).toBe(BattleStatus.OPEN);
      expect(mockBattleRepository.update).toHaveBeenCalledWith('battle-1', {
        status: BattleStatus.OPEN,
      });
      expect(mockBattleRepository.addHistory).toHaveBeenCalledWith(
        'battle-1',
        'BATTLE_OPENED',
        { previousStatus: BattleStatus.DRAFT }
      );
    });

    it('OPEN → RUNNING に遷移できるべき（参加者あり）', async () => {
      mockBattleRepository.findByIdAndTenant.mockResolvedValue({
        id: 'battle-1',
        tenantId: 'tenant-1',
        status: BattleStatus.OPEN,
      });
      mockBattleRepository.countActiveParticipants.mockResolvedValue(3);
      mockBattleRepository.update.mockResolvedValue({
        id: 'battle-1',
        status: BattleStatus.RUNNING,
      });
      mockBattleRepository.addHistory.mockResolvedValue({});

      const result = await transitionBattle(
        'battle-1',
        'tenant-1',
        BattleStatus.RUNNING
      );

      expect(result?.status).toBe(BattleStatus.RUNNING);
      expect(mockBattleRepository.update).toHaveBeenCalledWith('battle-1', {
        status: BattleStatus.RUNNING,
        startedAt: expect.any(Date),
      });
      expect(mockBattleRepository.addHistory).toHaveBeenCalledWith(
        'battle-1',
        'BATTLE_STARTED',
        { previousStatus: BattleStatus.OPEN }
      );
    });

    it('OPEN → RUNNING に参加者なしで遷移できないべき', async () => {
      mockBattleRepository.findByIdAndTenant.mockResolvedValue({
        id: 'battle-1',
        tenantId: 'tenant-1',
        status: BattleStatus.OPEN,
      });
      mockBattleRepository.countActiveParticipants.mockResolvedValue(0);

      await expect(
        transitionBattle('battle-1', 'tenant-1', BattleStatus.RUNNING)
      ).rejects.toThrow('参加者がいないためバトルを開始できません');
    });

    it('RUNNING → FINISHED に遷移できるべき', async () => {
      mockBattleRepository.findByIdAndTenant.mockResolvedValue({
        id: 'battle-1',
        tenantId: 'tenant-1',
        status: BattleStatus.RUNNING,
      });
      mockBattleRepository.update.mockResolvedValue({
        id: 'battle-1',
        status: BattleStatus.FINISHED,
      });
      mockBattleRepository.addHistory.mockResolvedValue({});

      const result = await transitionBattle(
        'battle-1',
        'tenant-1',
        BattleStatus.FINISHED
      );

      expect(result?.status).toBe(BattleStatus.FINISHED);
      expect(mockBattleRepository.update).toHaveBeenCalledWith('battle-1', {
        status: BattleStatus.FINISHED,
        endedAt: expect.any(Date),
      });
      expect(mockBattleRepository.addHistory).toHaveBeenCalledWith(
        'battle-1',
        'BATTLE_FINISHED',
        { previousStatus: BattleStatus.RUNNING }
      );
    });

    it('FINISHED → ARCHIVED に遷移できるべき', async () => {
      mockBattleRepository.findByIdAndTenant.mockResolvedValue({
        id: 'battle-1',
        tenantId: 'tenant-1',
        status: BattleStatus.FINISHED,
      });
      mockBattleRepository.update.mockResolvedValue({
        id: 'battle-1',
        status: BattleStatus.ARCHIVED,
      });
      mockBattleRepository.addHistory.mockResolvedValue({});

      const result = await transitionBattle(
        'battle-1',
        'tenant-1',
        BattleStatus.ARCHIVED
      );

      expect(result?.status).toBe(BattleStatus.ARCHIVED);
      expect(mockBattleRepository.addHistory).toHaveBeenCalledWith(
        'battle-1',
        'BATTLE_ARCHIVED',
        { previousStatus: BattleStatus.FINISHED }
      );
    });

    it('無効な遷移はエラーを投げるべき', async () => {
      mockBattleRepository.findByIdAndTenant.mockResolvedValue({
        id: 'battle-1',
        tenantId: 'tenant-1',
        status: BattleStatus.DRAFT,
      });

      await expect(
        transitionBattle('battle-1', 'tenant-1', BattleStatus.RUNNING)
      ).rejects.toThrow('DRAFT から RUNNING への遷移はできません');
    });

    it('ARCHIVED からの遷移はエラーを投げるべき', async () => {
      mockBattleRepository.findByIdAndTenant.mockResolvedValue({
        id: 'battle-1',
        tenantId: 'tenant-1',
        status: BattleStatus.ARCHIVED,
      });

      await expect(
        transitionBattle('battle-1', 'tenant-1', BattleStatus.OPEN)
      ).rejects.toThrow('ARCHIVED から OPEN への遷移はできません');
    });

    it('バトルが見つからない場合はnullを返すべき', async () => {
      mockBattleRepository.findByIdAndTenant.mockResolvedValue(null);

      const result = await transitionBattle(
        'non-existent',
        'tenant-1',
        BattleStatus.OPEN
      );

      expect(result).toBeNull();
    });
  });

  describe('joinBattle', () => {
    it('募集中のバトルに参加できるべき', async () => {
      const battleId = 'battle-1';
      const tenantId = 'tenant-1';
      const userId = 'user-1';

      mockBattleRepository.findByIdAndTenant.mockResolvedValue({
        id: battleId,
        tenantId,
        status: BattleStatus.OPEN,
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
        status: BattleStatus.OPEN,
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
        status: BattleStatus.OPEN,
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

    it('募集中以外のバトルには参加できないべき', async () => {
      mockBattleRepository.findByIdAndTenant.mockResolvedValue({
        id: 'battle-1',
        tenantId: 'tenant-1',
        status: BattleStatus.RUNNING,
        maxParticipants: 10,
      });

      await expect(
        joinBattle('battle-1', 'tenant-1', 'user-1')
      ).rejects.toThrow('募集中のバトルにのみ参加できます');
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
        status: BattleStatus.OPEN,
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

    it('実行中のバトルからは退出できないべき', async () => {
      mockBattleRepository.findByIdAndTenant.mockResolvedValue({
        id: 'battle-1',
        tenantId: 'tenant-1',
        status: BattleStatus.RUNNING,
      });

      await expect(
        leaveBattle('battle-1', 'tenant-1', 'user-1')
      ).rejects.toThrow('実行中のバトルからは退出できません');
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
        status: BattleStatus.OPEN,
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
        status: BattleStatus.RUNNING,
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

    it('実行中でないバトルのスコアは更新できないべき', async () => {
      mockBattleRepository.findByIdAndTenant.mockResolvedValue({
        id: 'battle-1',
        tenantId: 'tenant-1',
        status: BattleStatus.FINISHED,
      });

      await expect(
        updateScore('battle-1', 'tenant-1', 'user-1', 100)
      ).rejects.toThrow('実行中のバトルでのみスコアを更新できます');
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
        status: BattleStatus.RUNNING,
      });
      mockBattleRepository.getParticipant.mockResolvedValue(null);

      await expect(
        updateScore('battle-1', 'tenant-1', 'user-1', 100)
      ).rejects.toThrow('参加者が見つかりません');
    });
  });

  describe('addProblem', () => {
    it('下書きバトルに問題を追加できるべき', async () => {
      mockBattleRepository.findByIdAndTenant.mockResolvedValue({
        id: 'battle-1',
        tenantId: 'tenant-1',
        status: BattleStatus.DRAFT,
      });
      mockBattleRepository.addHistory.mockResolvedValue({});

      await addProblem('battle-1', 'tenant-1', 'problem-1');

      expect(mockBattleRepository.addHistory).toHaveBeenCalledWith(
        'battle-1',
        'PROBLEM_ADDED',
        { problemId: 'problem-1' }
      );
    });

    it('募集中のバトルに問題を追加できるべき', async () => {
      mockBattleRepository.findByIdAndTenant.mockResolvedValue({
        id: 'battle-1',
        tenantId: 'tenant-1',
        status: BattleStatus.OPEN,
      });
      mockBattleRepository.addHistory.mockResolvedValue({});

      await addProblem('battle-1', 'tenant-1', 'problem-1');

      expect(mockBattleRepository.addHistory).toHaveBeenCalled();
    });

    it('実行中のバトルには問題を追加できないべき', async () => {
      mockBattleRepository.findByIdAndTenant.mockResolvedValue({
        id: 'battle-1',
        tenantId: 'tenant-1',
        status: BattleStatus.RUNNING,
      });

      await expect(
        addProblem('battle-1', 'tenant-1', 'problem-1')
      ).rejects.toThrow('下書きまたは募集中のバトルにのみ問題を追加できます');
    });

    it('バトルが見つからない場合はエラーを投げるべき', async () => {
      mockBattleRepository.findByIdAndTenant.mockResolvedValue(null);

      await expect(
        addProblem('battle-1', 'tenant-1', 'problem-1')
      ).rejects.toThrow('バトルが見つかりません');
    });
  });
});
