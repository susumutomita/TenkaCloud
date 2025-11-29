/**
 * Event Repository Tests
 *
 * イベントリポジトリの単体テスト
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  InMemoryEventRepository,
  InMemoryLeaderboardRepository,
} from '../events/repository';
import type { Event, ScoringResult } from '../types';

// テスト用のモックデータ
const createMockEventData = (overrides: Partial<Omit<Event, 'id' | 'createdAt' | 'updatedAt'>> = {}): Omit<Event, 'id' | 'createdAt' | 'updatedAt'> => ({
  name: 'テストイベント',
  type: 'gameday',
  status: 'draft',
  tenantId: 'tenant-1',
  startTime: new Date('2024-06-01T09:00:00Z'),
  endTime: new Date('2024-06-01T18:00:00Z'),
  timezone: 'Asia/Tokyo',
  participantType: 'team',
  maxParticipants: 50,
  minTeamSize: 2,
  maxTeamSize: 5,
  cloudProvider: 'aws',
  regions: ['ap-northeast-1'],
  scoringType: 'realtime',
  scoringIntervalMinutes: 5,
  leaderboardVisible: true,
  ...overrides,
});

describe('InMemoryEventRepository', () => {
  let repository: InMemoryEventRepository;

  beforeEach(() => {
    repository = new InMemoryEventRepository();
  });

  describe('create', () => {
    it('新しいイベントを作成できるべき', async () => {
      const eventData = createMockEventData();
      const created = await repository.create(eventData);

      expect(created.id).toBeDefined();
      expect(created.id).toMatch(/^event-\d+$/);
      expect(created.name).toBe(eventData.name);
      expect(created.createdAt).toBeInstanceOf(Date);
      expect(created.updatedAt).toBeInstanceOf(Date);
    });

    it('連続して作成するとIDがインクリメントされるべき', async () => {
      const event1 = await repository.create(createMockEventData());
      const event2 = await repository.create(createMockEventData());

      expect(event1.id).toBe('event-1');
      expect(event2.id).toBe('event-2');
    });
  });

  describe('update', () => {
    it('既存のイベントを更新できるべき', async () => {
      const created = await repository.create(createMockEventData());

      const updated = await repository.update(created.id, {
        name: '更新後イベント名',
        status: 'scheduled',
      });

      expect(updated.name).toBe('更新後イベント名');
      expect(updated.status).toBe('scheduled');
      expect(updated.id).toBe(created.id);
      expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());
    });

    it('存在しないイベントを更新しようとするとエラーになるべき', async () => {
      await expect(
        repository.update('non-existent', { name: 'test' })
      ).rejects.toThrow("Event with id 'non-existent' not found");
    });

    it('更新時にIDを変更しようとしても元のIDが維持されるべき', async () => {
      const created = await repository.create(createMockEventData());

      const updated = await repository.update(created.id, {
        id: 'new-id',
        name: '更新後',
      } as Partial<Event>);

      expect(updated.id).toBe(created.id);
    });
  });

  describe('delete', () => {
    it('既存のイベントを削除できるべき', async () => {
      const created = await repository.create(createMockEventData());

      await repository.delete(created.id);

      const found = await repository.findById(created.id);
      expect(found).toBeNull();
    });

    it('存在しないイベントを削除しようとするとエラーになるべき', async () => {
      await expect(repository.delete('non-existent')).rejects.toThrow(
        "Event with id 'non-existent' not found"
      );
    });
  });

  describe('findById', () => {
    it('IDでイベントを取得できるべき', async () => {
      const created = await repository.create(createMockEventData());

      const found = await repository.findById(created.id);

      expect(found).not.toBeNull();
      expect(found?.id).toBe(created.id);
    });

    it('存在しないIDの場合はnullを返すべき', async () => {
      const found = await repository.findById('non-existent');
      expect(found).toBeNull();
    });
  });

  describe('findByTenant', () => {
    beforeEach(async () => {
      await repository.create(createMockEventData({
        tenantId: 'tenant-1',
        type: 'gameday',
        status: 'draft',
        startTime: new Date('2024-06-01T09:00:00Z'),
      }));
      await repository.create(createMockEventData({
        tenantId: 'tenant-1',
        type: 'jam',
        status: 'active',
        startTime: new Date('2024-07-01T09:00:00Z'),
      }));
      await repository.create(createMockEventData({
        tenantId: 'tenant-2',
        type: 'gameday',
        status: 'completed',
        startTime: new Date('2024-05-01T09:00:00Z'),
      }));
    });

    it('テナントIDでイベントを取得できるべき', async () => {
      const events = await repository.findByTenant('tenant-1');
      expect(events).toHaveLength(2);
      expect(events.every(e => e.tenantId === 'tenant-1')).toBe(true);
    });

    it('タイプでフィルタリングできるべき', async () => {
      const events = await repository.findByTenant('tenant-1', { type: 'gameday' });
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('gameday');
    });

    it('ステータスでフィルタリングできるべき（単一）', async () => {
      const events = await repository.findByTenant('tenant-1', { status: 'draft' });
      expect(events).toHaveLength(1);
      expect(events[0].status).toBe('draft');
    });

    it('ステータスでフィルタリングできるべき（複数）', async () => {
      const events = await repository.findByTenant('tenant-1', { status: ['draft', 'active'] });
      expect(events).toHaveLength(2);
    });

    it('開始日時でフィルタリングできるべき（after）', async () => {
      const events = await repository.findByTenant('tenant-1', {
        startAfter: new Date('2024-06-15T00:00:00Z'),
      });
      expect(events).toHaveLength(1);
      expect(events[0].startTime.getTime()).toBeGreaterThan(new Date('2024-06-15T00:00:00Z').getTime());
    });

    it('開始日時でフィルタリングできるべき（before）', async () => {
      const events = await repository.findByTenant('tenant-1', {
        startBefore: new Date('2024-06-15T00:00:00Z'),
      });
      expect(events).toHaveLength(1);
      expect(events[0].startTime.getTime()).toBeLessThan(new Date('2024-06-15T00:00:00Z').getTime());
    });

    it('開始日時の降順でソートされるべき', async () => {
      const events = await repository.findByTenant('tenant-1');
      expect(events[0].startTime.getTime()).toBeGreaterThan(events[1].startTime.getTime());
    });

    it('ページネーションが動作するべき', async () => {
      const page1 = await repository.findByTenant('tenant-1', { limit: 1, offset: 0 });
      const page2 = await repository.findByTenant('tenant-1', { limit: 1, offset: 1 });

      expect(page1).toHaveLength(1);
      expect(page2).toHaveLength(1);
      expect(page1[0].id).not.toBe(page2[0].id);
    });
  });

  describe('updateStatus', () => {
    it('イベントのステータスを更新できるべき', async () => {
      const created = await repository.create(createMockEventData({ status: 'draft' }));

      await repository.updateStatus(created.id, 'active');

      const found = await repository.findById(created.id);
      expect(found?.status).toBe('active');
    });
  });

  describe('clear', () => {
    it('全てのイベントをクリアできるべき', async () => {
      await repository.create(createMockEventData());
      await repository.create(createMockEventData());

      repository.clear();

      const events = await repository.findByTenant('tenant-1');
      expect(events).toHaveLength(0);
    });

    it('クリア後はIDカウンターもリセットされるべき', async () => {
      await repository.create(createMockEventData());
      repository.clear();
      const newEvent = await repository.create(createMockEventData());

      expect(newEvent.id).toBe('event-1');
    });
  });
});

describe('InMemoryLeaderboardRepository', () => {
  let repository: InMemoryLeaderboardRepository;

  beforeEach(() => {
    repository = new InMemoryLeaderboardRepository();
  });

  const createScoringResult = (overrides: Partial<ScoringResult> = {}): ScoringResult => ({
    eventId: 'event-1',
    problemId: 'problem-1',
    competitorAccountId: 'account-1',
    teamId: 'team-1',
    scores: [
      { criterion: 'EC2', score: 80, maxScore: 100 },
      { criterion: 'S3', score: 90, maxScore: 100 },
    ],
    totalScore: 170,
    maxTotalScore: 200,
    percentage: 85,
    scoredAt: new Date(),
    ...overrides,
  });

  describe('getLeaderboard', () => {
    it('存在しないイベントの場合はnullを返すべき', async () => {
      const leaderboard = await repository.getLeaderboard('non-existent');
      expect(leaderboard).toBeNull();
    });

    it('スコア更新後にリーダーボードを取得できるべき', async () => {
      await repository.updateScore('event-1', createScoringResult());

      const leaderboard = await repository.getLeaderboard('event-1');
      expect(leaderboard).not.toBeNull();
      expect(leaderboard?.eventId).toBe('event-1');
      expect(leaderboard?.entries).toHaveLength(1);
    });
  });

  describe('updateScore', () => {
    it('新しいエントリを作成できるべき', async () => {
      await repository.updateScore('event-1', createScoringResult({
        teamId: 'team-1',
        totalScore: 100,
      }));

      const leaderboard = await repository.getLeaderboard('event-1');
      expect(leaderboard?.entries).toHaveLength(1);
      expect(leaderboard?.entries[0].totalScore).toBe(100);
      expect(leaderboard?.entries[0].rank).toBe(1);
    });

    it('既存のエントリを更新できるべき', async () => {
      await repository.updateScore('event-1', createScoringResult({
        teamId: 'team-1',
        problemId: 'problem-1',
        totalScore: 100,
      }));

      await repository.updateScore('event-1', createScoringResult({
        teamId: 'team-1',
        problemId: 'problem-2',
        totalScore: 50,
      }));

      const leaderboard = await repository.getLeaderboard('event-1');
      expect(leaderboard?.entries).toHaveLength(1);
      expect(leaderboard?.entries[0].totalScore).toBe(150); // 100 + 50
      expect(leaderboard?.entries[0].problemScores['problem-1']).toBe(100);
      expect(leaderboard?.entries[0].problemScores['problem-2']).toBe(50);
    });

    it('複数チームの順位を正しく計算するべき', async () => {
      await repository.updateScore('event-1', createScoringResult({
        teamId: 'team-1',
        totalScore: 100,
      }));

      await repository.updateScore('event-1', createScoringResult({
        teamId: 'team-2',
        competitorAccountId: 'account-2',
        totalScore: 150,
      }));

      await repository.updateScore('event-1', createScoringResult({
        teamId: 'team-3',
        competitorAccountId: 'account-3',
        totalScore: 80,
      }));

      const leaderboard = await repository.getLeaderboard('event-1');
      expect(leaderboard?.entries[0].teamId).toBe('team-2');
      expect(leaderboard?.entries[0].rank).toBe(1);
      expect(leaderboard?.entries[1].teamId).toBe('team-1');
      expect(leaderboard?.entries[1].rank).toBe(2);
      expect(leaderboard?.entries[2].teamId).toBe('team-3');
      expect(leaderboard?.entries[2].rank).toBe(3);
    });

    it('スコアが上昇するとトレンドがupになるべき', async () => {
      await repository.updateScore('event-1', createScoringResult({
        teamId: 'team-1',
        problemId: 'problem-1',
        totalScore: 100,
      }));

      await repository.updateScore('event-1', createScoringResult({
        teamId: 'team-1',
        problemId: 'problem-2',
        totalScore: 50,
      }));

      const leaderboard = await repository.getLeaderboard('event-1');
      expect(leaderboard?.entries[0].trend).toBe('up');
    });

    it('スコアが変わらないとトレンドがsameになるべき', async () => {
      await repository.updateScore('event-1', createScoringResult({
        teamId: 'team-1',
        problemId: 'problem-1',
        totalScore: 100,
      }));

      await repository.updateScore('event-1', createScoringResult({
        teamId: 'team-1',
        problemId: 'problem-1',
        totalScore: 100,
      }));

      const leaderboard = await repository.getLeaderboard('event-1');
      expect(leaderboard?.entries[0].trend).toBe('same');
    });

    it('チームIDがない場合はparticipantIdを使用するべき', async () => {
      await repository.updateScore('event-1', createScoringResult({
        teamId: undefined,
        competitorAccountId: 'individual-1',
        totalScore: 100,
      }));

      const leaderboard = await repository.getLeaderboard('event-1');
      expect(leaderboard?.entries[0].participantId).toBe('individual-1');
      expect(leaderboard?.entries[0].teamId).toBeUndefined();
    });
  });

  describe('freezeLeaderboard', () => {
    it('リーダーボードを凍結できるべき', async () => {
      await repository.updateScore('event-1', createScoringResult());
      await repository.freezeLeaderboard('event-1');

      const leaderboard = await repository.getLeaderboard('event-1');
      expect(leaderboard?.isFrozen).toBe(true);
    });

    it('凍結中はスコアを更新しても順位が変わらないべき', async () => {
      await repository.updateScore('event-1', createScoringResult({
        teamId: 'team-1',
        totalScore: 100,
      }));

      await repository.updateScore('event-1', createScoringResult({
        teamId: 'team-2',
        competitorAccountId: 'account-2',
        totalScore: 50,
      }));

      await repository.freezeLeaderboard('event-1');

      // team-2のスコアが大幅アップしても順位は変わらない
      await repository.updateScore('event-1', createScoringResult({
        teamId: 'team-2',
        competitorAccountId: 'account-2',
        problemId: 'problem-2',
        totalScore: 200,
      }));

      const leaderboard = await repository.getLeaderboard('event-1');
      expect(leaderboard?.entries[0].teamId).toBe('team-1');
      expect(leaderboard?.entries[0].rank).toBe(1);
    });
  });

  describe('unfreezeLeaderboard', () => {
    it('リーダーボードの凍結を解除できるべき', async () => {
      await repository.updateScore('event-1', createScoringResult());
      await repository.freezeLeaderboard('event-1');
      await repository.unfreezeLeaderboard('event-1');

      const leaderboard = await repository.getLeaderboard('event-1');
      expect(leaderboard?.isFrozen).toBe(false);
    });

    it('凍結解除後は順位が再計算されるべき', async () => {
      await repository.updateScore('event-1', createScoringResult({
        teamId: 'team-1',
        totalScore: 100,
      }));

      await repository.updateScore('event-1', createScoringResult({
        teamId: 'team-2',
        competitorAccountId: 'account-2',
        totalScore: 50,
      }));

      await repository.freezeLeaderboard('event-1');

      // 凍結中に大幅スコアアップ
      await repository.updateScore('event-1', createScoringResult({
        teamId: 'team-2',
        competitorAccountId: 'account-2',
        problemId: 'problem-2',
        totalScore: 200,
      }));

      // 凍結解除
      await repository.unfreezeLeaderboard('event-1');

      const leaderboard = await repository.getLeaderboard('event-1');
      // team-2が1位になる
      expect(leaderboard?.entries[0].teamId).toBe('team-2');
      expect(leaderboard?.entries[0].rank).toBe(1);
    });
  });

  describe('resetLeaderboard', () => {
    it('リーダーボードをリセットできるべき', async () => {
      await repository.updateScore('event-1', createScoringResult());
      await repository.resetLeaderboard('event-1');

      const leaderboard = await repository.getLeaderboard('event-1');
      expect(leaderboard).toBeNull();
    });
  });

  describe('clear', () => {
    it('全てのリーダーボードをクリアできるべき', async () => {
      await repository.updateScore('event-1', createScoringResult());
      await repository.updateScore('event-2', createScoringResult({ eventId: 'event-2' }));

      repository.clear();

      const leaderboard1 = await repository.getLeaderboard('event-1');
      const leaderboard2 = await repository.getLeaderboard('event-2');
      expect(leaderboard1).toBeNull();
      expect(leaderboard2).toBeNull();
    });
  });
});
