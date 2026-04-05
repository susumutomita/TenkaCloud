/**
 * DynamoProblemTemplateRepository Tests
 *
 * 問題テンプレートリポジトリの単体テスト（DynamoDB 実装）
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockDynamoRepo } = vi.hoisted(() => ({
  mockDynamoRepo: {
    create: vi.fn(),
    findById: vi.fn(),
    list: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    incrementUsageCount: vi.fn(),
    count: vi.fn(),
  },
}));

vi.mock('../lib/dynamodb', () => ({
  eventRepository: {},
  problemTemplateRepository: mockDynamoRepo,
}));

import { PrismaProblemTemplateRepository } from '../repositories/template-repository';

// DynamoDB 形式のテンプレートモック
function makeDynamoTemplate(overrides = {}) {
  return {
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
    regions: { AWS: ['ap-northeast-1'] },
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
    ...overrides,
  };
}

describe('PrismaProblemTemplateRepository', () => {
  let repository: PrismaProblemTemplateRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    repository = new PrismaProblemTemplateRepository(mockDynamoRepo as never);
  });

  describe('create', () => {
    it('新しいテンプレートを作成できるべき', async () => {
      mockDynamoRepo.create.mockResolvedValue(makeDynamoTemplate());

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
      mockDynamoRepo.update.mockResolvedValue(
        makeDynamoTemplate({
          name: 'Updated Template',
          type: 'JAM',
          category: 'SECURITY',
          difficulty: 'HARD',
          status: 'PUBLISHED',
          version: '2.0.0',
        })
      );

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
      mockDynamoRepo.update.mockResolvedValue(
        makeDynamoTemplate({ status: 'PUBLISHED' })
      );

      const result = await repository.update('template-1', {
        status: 'published',
      });

      expect(result.status).toBe('published');
    });
  });

  describe('delete', () => {
    it('テンプレートを削除できるべき', async () => {
      mockDynamoRepo.delete.mockResolvedValue(undefined);

      await repository.delete('template-1');

      expect(mockDynamoRepo.delete).toHaveBeenCalledWith('template-1');
    });
  });

  describe('findById', () => {
    it('IDでテンプレートを取得できるべき', async () => {
      mockDynamoRepo.findById.mockResolvedValue(
        makeDynamoTemplate({
          category: 'COST',
          difficulty: 'EASY',
          scoringType: 'CONTAINER',
          usageCount: 10,
        })
      );

      const result = await repository.findById('template-1');

      expect(result).not.toBeNull();
      expect(result?.id).toBe('template-1');
      expect(result?.category).toBe('cost');
      expect(result?.difficulty).toBe('easy');
      expect(result?.usageCount).toBe(10);
    });

    it('見つからない場合は null を返すべき', async () => {
      mockDynamoRepo.findById.mockResolvedValue(null);

      const result = await repository.findById('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('findAll', () => {
    it('すべてのテンプレートを取得できるべき', async () => {
      mockDynamoRepo.list.mockResolvedValue({ templates: [] });

      await repository.findAll();

      expect(mockDynamoRepo.list).toHaveBeenCalled();
    });

    it('フィルター条件でテンプレートを取得できるべき', async () => {
      mockDynamoRepo.list.mockResolvedValue({ templates: [] });

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

      expect(mockDynamoRepo.list).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'GAMEDAY',
          category: 'RELIABILITY',
          difficulty: 'MEDIUM',
          status: 'PUBLISHED',
        })
      );
    });

    it('ページネーションが動作するべき', async () => {
      mockDynamoRepo.list.mockResolvedValue({ templates: [] });

      await repository.findAll({
        limit: 20,
        offset: 40,
      });

      expect(mockDynamoRepo.list).toHaveBeenCalledWith(
        expect.objectContaining({
          limit: 20,
        })
      );
    });
  });

  describe('search', () => {
    it('テキスト検索ができるべき', async () => {
      mockDynamoRepo.list.mockResolvedValue({ templates: [] });

      const result = await repository.search({
        query: 'aws vpc',
      });

      expect(result.templates).toHaveLength(0);
      expect(result.total).toBe(0);
    });

    it('フィルター条件で検索できるべき', async () => {
      mockDynamoRepo.list.mockResolvedValue({ templates: [] });

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

      expect(mockDynamoRepo.list).toHaveBeenCalled();
    });

    it('名前でソートできるべき', async () => {
      mockDynamoRepo.list.mockResolvedValue({
        templates: [
          makeDynamoTemplate({ name: 'B Template' }),
          makeDynamoTemplate({ id: 'template-2', name: 'A Template' }),
        ],
      });

      const result = await repository.search({ sortBy: 'name' });

      // 名前順にソートされる
      expect(result.templates[0].name).toBe('A Template');
      expect(result.templates[1].name).toBe('B Template');
    });

    it('使用回数でソートできるべき', async () => {
      mockDynamoRepo.list.mockResolvedValue({
        templates: [
          makeDynamoTemplate({ usageCount: 5 }),
          makeDynamoTemplate({ id: 'template-2', usageCount: 10 }),
        ],
      });

      const result = await repository.search({ sortBy: 'usageCount' });

      // 使用回数の多い順にソートされる
      expect(result.templates[0].usageCount).toBe(10);
      expect(result.templates[1].usageCount).toBe(5);
    });

    it('作成日時でソートできるべき', async () => {
      const older = new Date('2025-01-01');
      const newer = new Date('2025-06-01');
      mockDynamoRepo.list.mockResolvedValue({
        templates: [
          makeDynamoTemplate({ createdAt: older }),
          makeDynamoTemplate({ id: 'template-2', createdAt: newer }),
        ],
      });

      const result = await repository.search({ sortBy: 'newest' });

      // 新しい順にソートされる
      expect(result.templates[0].createdAt).toEqual(newer);
    });

    it('更新日時でソートできるべき', async () => {
      const older = new Date('2025-01-01');
      const newer = new Date('2025-06-01');
      mockDynamoRepo.list.mockResolvedValue({
        templates: [
          makeDynamoTemplate({ updatedAt: older }),
          makeDynamoTemplate({ id: 'template-2', updatedAt: newer }),
        ],
      });

      const result = await repository.search({ sortBy: 'updated' });

      // 更新が新しい順にソートされる
      expect(result.templates[0].updatedAt).toEqual(newer);
    });

    it('ページネーションが動作するべき', async () => {
      const mockTemplates = Array(50)
        .fill(null)
        .map((_, i) => makeDynamoTemplate({ id: `template-${i}` }));

      mockDynamoRepo.list.mockResolvedValue({ templates: mockTemplates });

      const result = await repository.search({ page: 2, limit: 10 });

      expect(result.page).toBe(2);
      expect(result.limit).toBe(10);
      expect(result.total).toBe(50);
      // page=2, limit=10: offset=10, so 50-10=40 items remain, hasMore=true
      expect(result.hasMore).toBe(true);
    });
  });

  describe('incrementUsageCount', () => {
    it('使用回数を増やせるべき', async () => {
      mockDynamoRepo.incrementUsageCount.mockResolvedValue(undefined);

      await repository.incrementUsageCount('template-1');

      expect(mockDynamoRepo.incrementUsageCount).toHaveBeenCalledWith(
        'template-1'
      );
    });
  });

  describe('count', () => {
    it('テンプレート数をカウントできるべき', async () => {
      mockDynamoRepo.count.mockResolvedValue(10);

      const result = await repository.count();

      expect(result).toBe(10);
    });

    it('フィルター条件でカウントできるべき', async () => {
      mockDynamoRepo.count.mockResolvedValue(5);

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
      mockDynamoRepo.findById.mockResolvedValue(makeDynamoTemplate());

      const result = await repository.exists('template-1');

      expect(result).toBe(true);
    });

    it('存在しない場合は false を返すべき', async () => {
      mockDynamoRepo.findById.mockResolvedValue(null);

      const result = await repository.exists('nonexistent');

      expect(result).toBe(false);
    });
  });

  describe('型変換', () => {
    it('すべての難易度レベルを変換できるべき', async () => {
      mockDynamoRepo.list.mockResolvedValue({ templates: [] });

      await repository.findAll({ difficulty: 'easy' });
      expect(mockDynamoRepo.list).toHaveBeenLastCalledWith(
        expect.objectContaining({ difficulty: 'EASY' })
      );

      await repository.findAll({ difficulty: 'medium' });
      expect(mockDynamoRepo.list).toHaveBeenLastCalledWith(
        expect.objectContaining({ difficulty: 'MEDIUM' })
      );

      await repository.findAll({ difficulty: 'hard' });
      expect(mockDynamoRepo.list).toHaveBeenLastCalledWith(
        expect.objectContaining({ difficulty: 'HARD' })
      );

      await repository.findAll({ difficulty: 'expert' });
      expect(mockDynamoRepo.list).toHaveBeenLastCalledWith(
        expect.objectContaining({ difficulty: 'EXPERT' })
      );
    });

    it('すべてのカテゴリを変換できるべき', async () => {
      mockDynamoRepo.list.mockResolvedValue({ templates: [] });

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
        expect(mockDynamoRepo.list).toHaveBeenLastCalledWith(
          expect.objectContaining({
            category: category.toUpperCase(),
          })
        );
      }
    });

    it('すべてのステータスを変換できるべき', async () => {
      mockDynamoRepo.list.mockResolvedValue({ templates: [] });

      const statuses = ['draft', 'published', 'archived'] as const;

      for (const status of statuses) {
        await repository.findAll({ status });
        expect(mockDynamoRepo.list).toHaveBeenLastCalledWith(
          expect.objectContaining({
            status: status.toUpperCase(),
          })
        );
      }
    });

    it('すべてのクラウドプロバイダーをフィルタリングできるべき', async () => {
      // Provider filtering is done in-memory for DynamoDB
      const templates = [
        makeDynamoTemplate({ providers: ['AWS'] }),
        makeDynamoTemplate({ id: 'template-2', providers: ['GCP'] }),
      ];
      mockDynamoRepo.list.mockResolvedValue({ templates });

      const result = await repository.findAll({ provider: 'aws' });

      expect(result.every((t) => t.deployment.providers.includes('aws'))).toBe(
        true
      );
    });
  });
});
