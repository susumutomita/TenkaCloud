/**
 * PrismaProblemRepository Tests
 *
 * Prisma問題リポジトリの単体テスト
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockPrisma, type MockPrisma } from './helpers/prisma-mock';

// Prisma をモック
vi.mock('../repositories/prisma-client', () => ({
  prisma: createMockPrisma(),
}));

import {
  PrismaProblemRepository,
  PrismaMarketplaceRepository,
} from '../repositories/problem-repository';
import { prisma } from '../repositories/prisma-client';

describe('PrismaProblemRepository', () => {
  let mockPrisma: MockPrisma;
  let repository: PrismaProblemRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma = prisma as unknown as MockPrisma;
    repository = new PrismaProblemRepository();
  });

  describe('create', () => {
    it('新しい問題を作成できるべき', async () => {
      const mockProblem = {
        id: 'problem-1',
        externalId: 'ext-1',
        title: 'Test Problem',
        type: 'GAMEDAY',
        category: 'ARCHITECTURE',
        difficulty: 'MEDIUM',
        author: 'Test Author',
        version: '1.0.0',
        tags: ['aws', 'cloudformation'],
        license: 'MIT',
        overview: 'Test overview',
        objectives: ['Objective 1'],
        hints: ['Hint 1'],
        prerequisites: ['Prerequisite 1'],
        estimatedTimeMinutes: 60,
        providers: ['AWS'],
        deploymentTimeoutMinutes: 30,
        scoringType: 'LAMBDA',
        scoringPath: '/scoring',
        scoringTimeoutMinutes: 5,
        scoringIntervalMinutes: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        templates: [],
        regions: [],
        criteria: [],
      };

      mockPrisma.problem.create.mockResolvedValue(mockProblem);

      const result = await repository.create({
        id: 'ext-1',
        title: 'Test Problem',
        type: 'gameday',
        category: 'architecture',
        difficulty: 'medium',
        description: {
          overview: 'Test overview',
          objectives: ['Objective 1'],
          hints: ['Hint 1'],
          prerequisites: ['Prerequisite 1'],
          estimatedTime: 60,
        },
        metadata: {
          author: 'Test Author',
          version: '1.0.0',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          tags: ['aws', 'cloudformation'],
          license: 'MIT',
        },
        deployment: {
          providers: ['aws'],
          timeout: 30,
          templates: {},
          regions: {},
        },
        scoring: {
          type: 'lambda',
          path: '/scoring',
          timeoutMinutes: 5,
          intervalMinutes: 1,
          criteria: [],
        },
      });

      expect(result.title).toBe('Test Problem');
      expect(result.type).toBe('gameday');
      expect(result.category).toBe('architecture');
    });
  });

  describe('update', () => {
    it('問題を更新できるべき', async () => {
      const mockProblem = {
        id: 'problem-1',
        externalId: 'ext-1',
        title: 'Updated Problem',
        type: 'JAM',
        category: 'SECURITY',
        difficulty: 'HARD',
        author: 'Test Author',
        version: '2.0.0',
        tags: ['security'],
        license: null,
        overview: 'Updated overview',
        objectives: ['New Objective'],
        hints: [],
        prerequisites: [],
        estimatedTimeMinutes: 120,
        providers: ['GCP'],
        deploymentTimeoutMinutes: 60,
        scoringType: 'CONTAINER',
        scoringPath: '/score',
        scoringTimeoutMinutes: 10,
        scoringIntervalMinutes: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        templates: [],
        regions: [],
        criteria: [],
      };

      mockPrisma.problem.update.mockResolvedValue(mockProblem);

      const result = await repository.update('problem-1', {
        title: 'Updated Problem',
        type: 'jam',
        category: 'security',
        difficulty: 'hard',
        description: {
          overview: 'Updated overview',
          objectives: ['New Objective'],
          estimatedTime: 120,
        },
        metadata: {
          version: '2.0.0',
          tags: ['security'],
        },
        deployment: {
          providers: ['gcp'],
          timeout: 60,
        },
      });

      expect(result.title).toBe('Updated Problem');
      expect(result.type).toBe('jam');
    });
  });

  describe('delete', () => {
    it('問題を削除できるべき', async () => {
      mockPrisma.problem.delete.mockResolvedValue({});

      await repository.delete('problem-1');

      expect(mockPrisma.problem.delete).toHaveBeenCalledWith({
        where: { id: 'problem-1' },
      });
    });
  });

  describe('findById', () => {
    it('IDで問題を取得できるべき', async () => {
      const mockProblem = {
        id: 'problem-1',
        externalId: 'ext-1',
        title: 'Test Problem',
        type: 'GAMEDAY',
        category: 'COST',
        difficulty: 'EASY',
        author: 'Test Author',
        version: '1.0.0',
        tags: [],
        license: null,
        overview: 'Test overview',
        objectives: [],
        hints: [],
        prerequisites: [],
        estimatedTimeMinutes: null,
        providers: ['AWS'],
        deploymentTimeoutMinutes: 30,
        scoringType: 'API',
        scoringPath: '/api/score',
        scoringTimeoutMinutes: 5,
        scoringIntervalMinutes: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        templates: [
          {
            provider: 'AWS',
            type: 'cloudformation',
            path: '/template.yaml',
            parameters: {},
          },
        ],
        regions: [{ provider: 'AWS', regions: ['ap-northeast-1'] }],
        criteria: [
          {
            name: 'Criterion 1',
            description: 'Test',
            weight: 1,
            maxPoints: 100,
          },
        ],
      };

      mockPrisma.problem.findUnique.mockResolvedValue(mockProblem);

      const result = await repository.findById('problem-1');

      expect(result).not.toBeNull();
      expect(result?.id).toBe('problem-1');
      expect(result?.category).toBe('cost');
      expect(result?.difficulty).toBe('easy');
    });

    it('見つからない場合は null を返すべき', async () => {
      mockPrisma.problem.findUnique.mockResolvedValue(null);

      const result = await repository.findById('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('findByExternalId', () => {
    it('外部IDで問題を取得できるべき', async () => {
      const mockProblem = {
        id: 'problem-1',
        externalId: 'ext-external',
        title: 'Test Problem',
        type: 'JAM',
        category: 'PERFORMANCE',
        difficulty: 'EXPERT',
        author: 'Test Author',
        version: '1.0.0',
        tags: [],
        license: null,
        overview: 'Test overview',
        objectives: [],
        hints: [],
        prerequisites: [],
        estimatedTimeMinutes: null,
        providers: ['AZURE'],
        deploymentTimeoutMinutes: 30,
        scoringType: 'MANUAL',
        scoringPath: null,
        scoringTimeoutMinutes: 5,
        scoringIntervalMinutes: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        templates: [],
        regions: [],
        criteria: [],
      };

      mockPrisma.problem.findUnique.mockResolvedValue(mockProblem);

      const result = await repository.findByExternalId('ext-external');

      expect(result).not.toBeNull();
      expect(result?.category).toBe('performance');
      expect(result?.difficulty).toBe('expert');
    });
  });

  describe('findAll', () => {
    it('すべての問題を取得できるべき', async () => {
      mockPrisma.problem.findMany.mockResolvedValue([]);

      await repository.findAll();

      expect(mockPrisma.problem.findMany).toHaveBeenCalled();
    });

    it('フィルター条件で問題を取得できるべき', async () => {
      mockPrisma.problem.findMany.mockResolvedValue([]);

      await repository.findAll({
        type: 'gameday',
        category: 'reliability',
        difficulty: 'medium',
        author: 'Test Author',
        tags: ['aws'],
        limit: 10,
        offset: 0,
      });

      expect(mockPrisma.problem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            type: 'GAMEDAY',
            category: 'RELIABILITY',
            difficulty: 'MEDIUM',
            author: 'Test Author',
          }),
        })
      );
    });
  });

  describe('count', () => {
    it('問題数をカウントできるべき', async () => {
      mockPrisma.problem.count.mockResolvedValue(10);

      const result = await repository.count();

      expect(result).toBe(10);
    });

    it('フィルター条件でカウントできるべき', async () => {
      mockPrisma.problem.count.mockResolvedValue(5);

      const result = await repository.count({
        type: 'jam',
        category: 'operations',
        difficulty: 'hard',
      });

      expect(result).toBe(5);
    });
  });

  describe('exists', () => {
    it('存在する場合は true を返すべき', async () => {
      mockPrisma.problem.count.mockResolvedValue(1);

      const result = await repository.exists('problem-1');

      expect(result).toBe(true);
    });

    it('存在しない場合は false を返すべき', async () => {
      mockPrisma.problem.count.mockResolvedValue(0);

      const result = await repository.exists('nonexistent');

      expect(result).toBe(false);
    });
  });
});

describe('PrismaMarketplaceRepository', () => {
  let mockPrisma: MockPrisma;
  let repository: PrismaMarketplaceRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma = prisma as unknown as MockPrisma;
    repository = new PrismaMarketplaceRepository();
  });

  describe('publish', () => {
    it('問題をマーケットプレイスに公開できるべき', async () => {
      const mockProblem = {
        id: 'problem-1',
        author: 'Test Author',
      };

      const mockListing = {
        id: 'listing-1',
        problemId: 'problem-1',
        publisherId: 'Test Author',
        publisherName: 'Test Author',
        isVerified: false,
        isFeatured: false,
        downloadCount: 0,
        averageRating: 0,
        reviewCount: 0,
        publishedAt: new Date(),
        problem: {
          id: 'problem-1',
          externalId: 'ext-1',
          title: 'Test Problem',
          type: 'GAMEDAY',
          category: 'ARCHITECTURE',
          difficulty: 'MEDIUM',
          author: 'Test Author',
          version: '1.0.0',
          tags: [],
          license: null,
          overview: 'Test overview',
          objectives: [],
          hints: [],
          prerequisites: [],
          estimatedTimeMinutes: null,
          providers: ['AWS'],
          deploymentTimeoutMinutes: 30,
          scoringType: 'LAMBDA',
          scoringPath: '/scoring',
          scoringTimeoutMinutes: 5,
          scoringIntervalMinutes: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          templates: [],
          regions: [],
          criteria: [],
        },
        reviews: [],
      };

      mockPrisma.problem.findUnique.mockResolvedValue(mockProblem);
      mockPrisma.marketplaceListing.upsert.mockResolvedValue(mockListing);

      const result = await repository.publish('problem-1');

      expect(result.marketplaceId).toBe('listing-1');
      expect(result.status).toBe('published');
    });

    it('問題が見つからない場合はエラーをスローするべき', async () => {
      mockPrisma.problem.findUnique.mockResolvedValue(null);

      await expect(repository.publish('nonexistent')).rejects.toThrow(
        "Problem with id 'nonexistent' not found"
      );
    });
  });

  describe('unpublish', () => {
    it('マーケットプレイスから問題を削除できるべき', async () => {
      mockPrisma.marketplaceListing.delete.mockResolvedValue({});

      await repository.unpublish('listing-1');

      expect(mockPrisma.marketplaceListing.delete).toHaveBeenCalledWith({
        where: { id: 'listing-1' },
      });
    });
  });

  describe('search', () => {
    it('マーケットプレイスを検索できるべき', async () => {
      mockPrisma.marketplaceListing.findMany.mockResolvedValue([]);
      mockPrisma.marketplaceListing.count.mockResolvedValue(0);

      const result = await repository.search({});

      expect(result.problems).toHaveLength(0);
      expect(result.total).toBe(0);
    });

    it('フィルター条件で検索できるべき', async () => {
      mockPrisma.marketplaceListing.findMany.mockResolvedValue([]);
      mockPrisma.marketplaceListing.count.mockResolvedValue(0);

      await repository.search({
        query: 'aws',
        type: 'gameday',
        category: 'architecture',
        difficulty: 'medium',
        provider: 'aws',
        sortBy: 'rating',
        page: 1,
        limit: 20,
      });

      expect(mockPrisma.marketplaceListing.findMany).toHaveBeenCalled();
    });

    it('ダウンロード数でソートできるべき', async () => {
      mockPrisma.marketplaceListing.findMany.mockResolvedValue([]);
      mockPrisma.marketplaceListing.count.mockResolvedValue(0);

      await repository.search({ sortBy: 'downloads' });

      expect(mockPrisma.marketplaceListing.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { downloadCount: 'desc' },
        })
      );
    });

    it('最新順でソートできるべき', async () => {
      mockPrisma.marketplaceListing.findMany.mockResolvedValue([]);
      mockPrisma.marketplaceListing.count.mockResolvedValue(0);

      await repository.search({ sortBy: 'newest' });

      expect(mockPrisma.marketplaceListing.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { publishedAt: 'desc' },
        })
      );
    });
  });

  describe('findById', () => {
    it('マーケットプレイスアイテムを取得できるべき', async () => {
      const mockListing = {
        id: 'listing-1',
        problemId: 'problem-1',
        downloadCount: 100,
        averageRating: 4.5,
        publishedAt: new Date(),
        problem: {
          id: 'problem-1',
          externalId: 'ext-1',
          title: 'Test Problem',
          type: 'GAMEDAY',
          category: 'ARCHITECTURE',
          difficulty: 'MEDIUM',
          author: 'Test Author',
          version: '1.0.0',
          tags: [],
          license: null,
          overview: 'Test',
          objectives: [],
          hints: [],
          prerequisites: [],
          estimatedTimeMinutes: null,
          providers: ['AWS'],
          deploymentTimeoutMinutes: 30,
          scoringType: 'LAMBDA',
          scoringPath: '/scoring',
          scoringTimeoutMinutes: 5,
          scoringIntervalMinutes: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          templates: [],
          regions: [],
          criteria: [],
        },
        reviews: [],
      };

      mockPrisma.marketplaceListing.findUnique.mockResolvedValue(mockListing);

      const result = await repository.findById('listing-1');

      expect(result).not.toBeNull();
      expect(result?.marketplaceId).toBe('listing-1');
    });

    it('見つからない場合は null を返すべき', async () => {
      mockPrisma.marketplaceListing.findUnique.mockResolvedValue(null);

      const result = await repository.findById('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('incrementDownloads', () => {
    it('ダウンロード数を増やせるべき', async () => {
      mockPrisma.marketplaceListing.update.mockResolvedValue({});

      await repository.incrementDownloads('listing-1');

      expect(mockPrisma.marketplaceListing.update).toHaveBeenCalledWith({
        where: { id: 'listing-1' },
        data: { downloadCount: { increment: 1 } },
      });
    });
  });

  describe('addReview', () => {
    it('レビューを追加できるべき', async () => {
      const mockReviews = [{ rating: 5 }, { rating: 4 }];

      mockPrisma.$transaction.mockImplementation(async (fn) => {
        const tx = {
          marketplaceReview: {
            create: vi.fn().mockResolvedValue({}),
            findMany: vi.fn().mockResolvedValue(mockReviews),
          },
          marketplaceListing: {
            update: vi.fn().mockResolvedValue({}),
          },
        };
        return fn(tx);
      });

      await repository.addReview('listing-1', {
        userId: 'user-1',
        userName: 'Test User',
        rating: 5,
        comment: 'Great problem!',
      });

      expect(mockPrisma.$transaction).toHaveBeenCalled();
    });
  });
});
