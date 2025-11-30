/**
 * Locking Module Tests
 *
 * ペシミスティックロック機構の単体テスト
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockPrisma, type MockPrisma } from './helpers/prisma-mock';

// Prisma をモック
vi.mock('../repositories', () => ({
  prisma: createMockPrisma(),
}));

import {
  acquireLock,
  releaseLock,
  withLock,
  withSerializableTransaction,
} from '../jam/locking';
import { prisma } from '../repositories';

describe('ペシミスティックロック', () => {
  let mockPrisma: MockPrisma;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma = prisma as unknown as MockPrisma;
  });

  describe('acquireLock', () => {
    it('ロックを取得できるべき', async () => {
      mockPrisma.$executeRaw.mockResolvedValue(1);

      const result = await acquireLock('team-1', 'challenge-1');

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('ロック取得に失敗した場合はリトライするべき', async () => {
      // 最初の2回は失敗、3回目で成功
      mockPrisma.$executeRaw
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(1);

      const result = await acquireLock('team-1', 'challenge-1', 3, 10);

      expect(result.success).toBe(true);
      expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(3);
    });

    it('最大リトライ回数を超えた場合はエラーを返すべき', async () => {
      mockPrisma.$executeRaw.mockResolvedValue(0);

      const result = await acquireLock('team-1', 'challenge-1', 3, 10);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Max retries exceeded');
      expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(3);
    });

    it('例外が発生した場合はエラーを返すべき', async () => {
      mockPrisma.$executeRaw.mockRejectedValue(new Error('Database error'));

      const result = await acquireLock('team-1', 'challenge-1', 1);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Database error');
    });
  });

  describe('releaseLock', () => {
    it('ロックを解放できるべき', async () => {
      mockPrisma.teamChallengeAnswer.update.mockResolvedValue({});

      const result = await releaseLock('team-1', 'challenge-1');

      expect(result).toBe(true);
      expect(mockPrisma.teamChallengeAnswer.update).toHaveBeenCalledWith({
        where: {
          teamId_challengeId: { teamId: 'team-1', challengeId: 'challenge-1' },
        },
        data: { pessimisticLocking: false },
      });
    });

    it('例外が発生した場合は false を返すべき', async () => {
      mockPrisma.teamChallengeAnswer.update.mockRejectedValue(
        new Error('Database error')
      );

      const result = await releaseLock('team-1', 'challenge-1');

      expect(result).toBe(false);
    });
  });

  describe('withLock', () => {
    it('ロック付きで処理を実行できるべき', async () => {
      mockPrisma.$executeRaw.mockResolvedValue(1);
      mockPrisma.teamChallengeAnswer.update.mockResolvedValue({});

      const operation = vi.fn().mockResolvedValue({ data: 'test' });

      const result = await withLock('team-1', 'challenge-1', operation);

      expect(result.success).toBe(true);
      expect(result.result).toEqual({ data: 'test' });
      expect(operation).toHaveBeenCalled();
      expect(mockPrisma.teamChallengeAnswer.update).toHaveBeenCalled(); // ロック解放
    });

    it('ロック取得に失敗した場合はエラーを返すべき', async () => {
      mockPrisma.$executeRaw.mockResolvedValue(0);

      const operation = vi.fn();

      const result = await withLock('team-1', 'challenge-1', operation);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Max retries exceeded');
      expect(operation).not.toHaveBeenCalled();
    });

    it('処理中に例外が発生してもロックは解放されるべき', async () => {
      mockPrisma.$executeRaw.mockResolvedValue(1);
      mockPrisma.teamChallengeAnswer.update.mockResolvedValue({});

      const operation = vi.fn().mockRejectedValue(new Error('Operation error'));

      const result = await withLock('team-1', 'challenge-1', operation);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Operation error');
      expect(mockPrisma.teamChallengeAnswer.update).toHaveBeenCalled(); // ロック解放
    });
  });

  describe('withSerializableTransaction', () => {
    it('Serializable トランザクションを実行できるべき', async () => {
      const mockResult = { data: 'test' };
      mockPrisma.$transaction.mockImplementation(async (fn) => {
        return fn(mockPrisma);
      });

      const operation = vi.fn().mockResolvedValue(mockResult);

      const result = await withSerializableTransaction(operation);

      expect(result).toEqual(mockResult);
      expect(mockPrisma.$transaction).toHaveBeenCalledWith(
        expect.any(Function),
        {
          isolationLevel: 'Serializable',
          timeout: 10000,
        }
      );
    });
  });
});
