/**
 * PrismaProblemTemplateRepository Tests
 *
 * Prisma問題テンプレートリポジトリの単体テスト
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockPrisma, type MockPrisma } from './helpers/prisma-mock';

// Prisma をモック
vi.mock('../repositories/prisma-client', () => ({
  prisma: createMockPrisma(),
}));

import { PrismaProblemTemplateRepository } from '../repositories/template-repository';
import { prisma } from '../repositories/prisma-client';

describe('PrismaProblemTemplateRepository', () => {
  let mockPrisma: MockPrisma;
  let repository: PrismaProblemTemplateRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma = prisma as unknown as MockPrisma;
    repository = new PrismaProblemTemplateRepository();
  });

  describe('create', () => {
    it('新しいテンプレートを作成できるべき', async () => {
      const mockTemplate = {
        id: 'template-1',
        name: 'Test Template',
        description: 'Test Description',
        type: 'GAMEDAY',
        category: 'ARCHITECTURE',
        difficulty: 'MEDIUM',
        status: 'DRAFT',
        variables: [
          {
            name: 'region',
            type: 'select',
            description: 'AWS Region',
            options: ['ap-northeast-1', 'us-east-1'],
            required: true,
          },
        ],
        overviewTemplate: 'Deploy resources in {{region}}',
        objectivesTemplate: ['Create VPC', 'Launch EC2'],
        hintsTemplate: ['Check VPC settings'],
        prerequisites: ['AWS knowledge'],
        estimatedTimeMinutes: 60,
        providers: ['AWS'],
        templateType: 'CLOUDFORMATION',
        templateContent: 'AWSTemplateFormatVersion: 2010-09-09',
        regions: { aws: ['ap-northeast-1'] },
        deploymentTimeout: 30,
        scoringType: 'LAMBDA',
        criteriaTemplate: [{ weight: 1, maxPoints: 100 }],
        scoringTimeout: 10,
        tags: ['aws', 'vpc'],
        author: 'Test Author',
        version: '1.0.0',
        usageCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrisma.problemTemplate.create.mockResolvedValue(mockTemplate);

      const result = await repository.create({
        name: 'Test Template',
        description: 'Test Description',
        type: 'gameday',
        category: 'architecture',
        difficulty: 'medium',
        status: 'draft',
        variables: [
          {
            name: 'region',
            type: 'select',
            description: 'AWS Region',
            options: ['ap-northeast-1', 'us-east-1'],
            required: true,
          },
        ],
        descriptionTemplate: {
          overviewTemplate: 'Deploy resources in {{region}}',
          objectivesTemplate: ['Create VPC', 'Launch EC2'],
          hintsTemplate: ['Check VPC settings'],
          prerequisites: ['AWS knowledge'],
          estimatedTime: 60,
        },
        deployment: {
          providers: ['aws'],
          templateType: 'cloudformation',
          templateContent: 'AWSTemplateFormatVersion: 2010-09-09',
          regions: { aws: ['ap-northeast-1'] },
          timeout: 30,
        },
        scoring: {
          type: 'lambda',
          criteriaTemplate: [{ weight: 1, maxPoints: 100 }],
          timeoutMinutes: 10,
        },
        tags: ['aws', 'vpc'],
        author: 'Test Author',
        version: '1.0.0',
        usageCount: 0,
      });

      expect(result.name).toBe('Test Template');
      expect(result.type).toBe('gameday');
      expect(result.category).toBe('architecture');
      expect(result.status).toBe('draft');
    });
  });

  describe('update', () => {
    it('テンプレートを更新できるべき', async () => {
      const mockTemplate = {
        id: 'template-1',
        name: 'Updated Template',
        description: 'Updated Description',
        type: 'JAM',
        category: 'SECURITY',
        difficulty: 'HARD',
        status: 'PUBLISHED',
        variables: [],
        overviewTemplate: 'Updated overview',
        objectivesTemplate: ['New Objective'],
        hintsTemplate: [],
        prerequisites: [],
        estimatedTimeMinutes: 120,
        providers: ['GCP'],
        templateType: 'TERRAFORM',
        templateContent: 'resource "google_compute_instance"',
        regions: { gcp: ['asia-northeast1'] },
        deploymentTimeout: 60,
        scoringType: 'API',
        criteriaTemplate: [],
        scoringTimeout: 15,
        tags: ['gcp'],
        author: 'Test Author',
        version: '2.0.0',
        usageCount: 5,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrisma.problemTemplate.update.mockResolvedValue(mockTemplate);

      const result = await repository.update('template-1', {
        name: 'Updated Template',
        type: 'jam',
        category: 'security',
        difficulty: 'hard',
        status: 'published',
        version: '2.0.0',
      });

      expect(result.name).toBe('Updated Template');
      expect(result.type).toBe('jam');
      expect(result.status).toBe('published');
    });

    it('部分的な更新ができるべき', async () => {
      const mockTemplate = {
        id: 'template-1',
        name: 'Test Template',
        description: 'Test Description',
        type: 'GAMEDAY',
        category: 'ARCHITECTURE',
        difficulty: 'MEDIUM',
        status: 'PUBLISHED',
        variables: [],
        overviewTemplate: 'Overview',
        objectivesTemplate: [],
        hintsTemplate: [],
        prerequisites: [],
        estimatedTimeMinutes: null,
        providers: ['AWS'],
        templateType: 'CLOUDFORMATION',
        templateContent: 'content',
        regions: {},
        deploymentTimeout: 30,
        scoringType: 'LAMBDA',
        criteriaTemplate: [],
        scoringTimeout: 10,
        tags: [],
        author: 'Test Author',
        version: '1.0.0',
        usageCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrisma.problemTemplate.update.mockResolvedValue(mockTemplate);

      const result = await repository.update('template-1', {
        status: 'published',
      });

      expect(result.status).toBe('published');
    });
  });

  describe('delete', () => {
    it('テンプレートを削除できるべき', async () => {
      mockPrisma.problemTemplate.delete.mockResolvedValue({});

      await repository.delete('template-1');

      expect(mockPrisma.problemTemplate.delete).toHaveBeenCalledWith({
        where: { id: 'template-1' },
      });
    });
  });

  describe('findById', () => {
    it('IDでテンプレートを取得できるべき', async () => {
      const mockTemplate = {
        id: 'template-1',
        name: 'Test Template',
        description: 'Test Description',
        type: 'GAMEDAY',
        category: 'COST',
        difficulty: 'EASY',
        status: 'DRAFT',
        variables: [],
        overviewTemplate: 'Overview',
        objectivesTemplate: ['Obj 1'],
        hintsTemplate: ['Hint 1'],
        prerequisites: [],
        estimatedTimeMinutes: 30,
        providers: ['AWS'],
        templateType: 'SAM',
        templateContent: 'Transform: AWS::Serverless-2016-10-31',
        regions: {},
        deploymentTimeout: 30,
        scoringType: 'CONTAINER',
        criteriaTemplate: [],
        scoringTimeout: 10,
        tags: ['serverless'],
        author: 'Test Author',
        version: '1.0.0',
        usageCount: 10,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrisma.problemTemplate.findUnique.mockResolvedValue(mockTemplate);

      const result = await repository.findById('template-1');

      expect(result).not.toBeNull();
      expect(result?.id).toBe('template-1');
      expect(result?.category).toBe('cost');
      expect(result?.difficulty).toBe('easy');
      expect(result?.usageCount).toBe(10);
    });

    it('見つからない場合は null を返すべき', async () => {
      mockPrisma.problemTemplate.findUnique.mockResolvedValue(null);

      const result = await repository.findById('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('findAll', () => {
    it('すべてのテンプレートを取得できるべき', async () => {
      mockPrisma.problemTemplate.findMany.mockResolvedValue([]);

      await repository.findAll();

      expect(mockPrisma.problemTemplate.findMany).toHaveBeenCalled();
    });

    it('フィルター条件でテンプレートを取得できるべき', async () => {
      mockPrisma.problemTemplate.findMany.mockResolvedValue([]);

      await repository.findAll({
        type: 'gameday',
        category: 'reliability',
        difficulty: 'medium',
        status: 'published',
        author: 'Test Author',
        tags: ['aws'],
        provider: 'aws',
        limit: 10,
        offset: 0,
      });

      expect(mockPrisma.problemTemplate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            type: 'GAMEDAY',
            category: 'RELIABILITY',
            difficulty: 'MEDIUM',
            status: 'PUBLISHED',
            author: 'Test Author',
          }),
        })
      );
    });

    it('ページネーションが動作するべき', async () => {
      mockPrisma.problemTemplate.findMany.mockResolvedValue([]);

      await repository.findAll({
        limit: 20,
        offset: 40,
      });

      expect(mockPrisma.problemTemplate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 40,
          take: 20,
        })
      );
    });
  });

  describe('search', () => {
    it('テキスト検索ができるべき', async () => {
      mockPrisma.problemTemplate.findMany.mockResolvedValue([]);
      mockPrisma.problemTemplate.count.mockResolvedValue(0);

      const result = await repository.search({
        query: 'aws vpc',
      });

      expect(result.templates).toHaveLength(0);
      expect(result.total).toBe(0);
    });

    it('フィルター条件で検索できるべき', async () => {
      mockPrisma.problemTemplate.findMany.mockResolvedValue([]);
      mockPrisma.problemTemplate.count.mockResolvedValue(0);

      await repository.search({
        query: 'aws',
        type: 'gameday',
        category: 'architecture',
        difficulty: 'medium',
        status: 'published',
        provider: 'aws',
        tags: ['vpc'],
        sortBy: 'usageCount',
        page: 1,
        limit: 20,
      });

      expect(mockPrisma.problemTemplate.findMany).toHaveBeenCalled();
    });

    it('名前でソートできるべき', async () => {
      mockPrisma.problemTemplate.findMany.mockResolvedValue([]);
      mockPrisma.problemTemplate.count.mockResolvedValue(0);

      await repository.search({ sortBy: 'name' });

      expect(mockPrisma.problemTemplate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { name: 'asc' },
        })
      );
    });

    it('使用回数でソートできるべき', async () => {
      mockPrisma.problemTemplate.findMany.mockResolvedValue([]);
      mockPrisma.problemTemplate.count.mockResolvedValue(0);

      await repository.search({ sortBy: 'usageCount' });

      expect(mockPrisma.problemTemplate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { usageCount: 'desc' },
        })
      );
    });

    it('作成日時でソートできるべき', async () => {
      mockPrisma.problemTemplate.findMany.mockResolvedValue([]);
      mockPrisma.problemTemplate.count.mockResolvedValue(0);

      await repository.search({ sortBy: 'newest' });

      expect(mockPrisma.problemTemplate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { createdAt: 'desc' },
        })
      );
    });

    it('更新日時でソートできるべき', async () => {
      mockPrisma.problemTemplate.findMany.mockResolvedValue([]);
      mockPrisma.problemTemplate.count.mockResolvedValue(0);

      await repository.search({ sortBy: 'updated' });

      expect(mockPrisma.problemTemplate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { updatedAt: 'desc' },
        })
      );
    });

    it('ページネーションが動作するべき', async () => {
      const mockTemplates = [
        {
          id: 'template-1',
          name: 'Template 1',
          description: 'Desc',
          type: 'GAMEDAY',
          category: 'ARCHITECTURE',
          difficulty: 'MEDIUM',
          status: 'PUBLISHED',
          variables: [],
          overviewTemplate: 'Overview',
          objectivesTemplate: [],
          hintsTemplate: [],
          prerequisites: [],
          estimatedTimeMinutes: null,
          providers: ['AWS'],
          templateType: 'CLOUDFORMATION',
          templateContent: '',
          regions: {},
          deploymentTimeout: 30,
          scoringType: 'LAMBDA',
          criteriaTemplate: [],
          scoringTimeout: 10,
          tags: [],
          author: 'Author',
          version: '1.0.0',
          usageCount: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      mockPrisma.problemTemplate.findMany.mockResolvedValue(mockTemplates);
      mockPrisma.problemTemplate.count.mockResolvedValue(50);

      const result = await repository.search({ page: 2, limit: 10 });

      expect(result.page).toBe(2);
      expect(result.limit).toBe(10);
      expect(result.hasMore).toBe(true);
      expect(mockPrisma.problemTemplate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 10,
          take: 10,
        })
      );
    });
  });

  describe('incrementUsageCount', () => {
    it('使用回数を増やせるべき', async () => {
      mockPrisma.problemTemplate.update.mockResolvedValue({});

      await repository.incrementUsageCount('template-1');

      expect(mockPrisma.problemTemplate.update).toHaveBeenCalledWith({
        where: { id: 'template-1' },
        data: {
          usageCount: { increment: 1 },
        },
      });
    });
  });

  describe('count', () => {
    it('テンプレート数をカウントできるべき', async () => {
      mockPrisma.problemTemplate.count.mockResolvedValue(10);

      const result = await repository.count();

      expect(result).toBe(10);
    });

    it('フィルター条件でカウントできるべき', async () => {
      mockPrisma.problemTemplate.count.mockResolvedValue(5);

      const result = await repository.count({
        type: 'jam',
        category: 'operations',
        difficulty: 'hard',
        status: 'published',
      });

      expect(result).toBe(5);
    });
  });

  describe('exists', () => {
    it('存在する場合は true を返すべき', async () => {
      mockPrisma.problemTemplate.count.mockResolvedValue(1);

      const result = await repository.exists('template-1');

      expect(result).toBe(true);
    });

    it('存在しない場合は false を返すべき', async () => {
      mockPrisma.problemTemplate.count.mockResolvedValue(0);

      const result = await repository.exists('nonexistent');

      expect(result).toBe(false);
    });
  });

  describe('型変換', () => {
    it('すべての難易度レベルを変換できるべき', async () => {
      mockPrisma.problemTemplate.findMany.mockResolvedValue([]);

      // easy
      await repository.findAll({ difficulty: 'easy' });
      expect(mockPrisma.problemTemplate.findMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ difficulty: 'EASY' }),
        })
      );

      // medium
      await repository.findAll({ difficulty: 'medium' });
      expect(mockPrisma.problemTemplate.findMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ difficulty: 'MEDIUM' }),
        })
      );

      // hard
      await repository.findAll({ difficulty: 'hard' });
      expect(mockPrisma.problemTemplate.findMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ difficulty: 'HARD' }),
        })
      );

      // expert
      await repository.findAll({ difficulty: 'expert' });
      expect(mockPrisma.problemTemplate.findMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ difficulty: 'EXPERT' }),
        })
      );
    });

    it('すべてのカテゴリを変換できるべき', async () => {
      mockPrisma.problemTemplate.findMany.mockResolvedValue([]);

      const categories = [
        'architecture',
        'security',
        'cost',
        'performance',
        'reliability',
        'operations',
      ] as const;

      for (const category of categories) {
        await repository.findAll({ category });
        expect(mockPrisma.problemTemplate.findMany).toHaveBeenLastCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              category: category.toUpperCase(),
            }),
          })
        );
      }
    });

    it('すべてのクラウドプロバイダーを変換できるべき', async () => {
      mockPrisma.problemTemplate.findMany.mockResolvedValue([]);

      const providers = ['aws', 'gcp', 'azure', 'local'] as const;

      for (const provider of providers) {
        await repository.findAll({ provider });
        expect(mockPrisma.problemTemplate.findMany).toHaveBeenLastCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              providers: { has: provider.toUpperCase() },
            }),
          })
        );
      }
    });

    it('すべてのステータスを変換できるべき', async () => {
      mockPrisma.problemTemplate.findMany.mockResolvedValue([]);

      const statuses = ['draft', 'published', 'archived'] as const;

      for (const status of statuses) {
        await repository.findAll({ status });
        expect(mockPrisma.problemTemplate.findMany).toHaveBeenLastCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              status: status.toUpperCase(),
            }),
          })
        );
      }
    });
  });
});
