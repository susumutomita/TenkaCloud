/**
 * Problem Repository Tests
 *
 * 問題リポジトリの単体テスト
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  InMemoryProblemRepository,
  InMemoryMarketplaceRepository,
} from '../problems/repository';
import type { Problem } from '../types';

// テスト用のモックデータ
const createMockProblem = (overrides: Partial<Problem> = {}): Problem => ({
  id: 'test-problem-1',
  title: 'テスト問題',
  type: 'gameday',
  category: 'architecture',
  difficulty: 'medium',
  metadata: {
    author: 'test-author',
    version: '1.0.0',
    createdAt: '2024-01-01',
    tags: ['aws', 'ec2'],
  },
  description: {
    overview: 'テスト概要',
    objectives: ['目標1', '目標2'],
    hints: ['ヒント1'],
  },
  deployment: {
    providers: ['aws'],
    templates: {
      aws: {
        type: 'cloudformation',
        path: '/templates/test.yaml',
      },
    },
    regions: {
      aws: ['ap-northeast-1'],
    },
  },
  scoring: {
    type: 'lambda',
    path: '/scoring/test',
    criteria: [
      { name: 'EC2構築', weight: 50, maxPoints: 50 },
      { name: 'S3設定', weight: 50, maxPoints: 50 },
    ],
    timeoutMinutes: 10,
  },
  ...overrides,
});

describe('InMemoryProblemRepository', () => {
  let repository: InMemoryProblemRepository;

  beforeEach(() => {
    repository = new InMemoryProblemRepository();
  });

  describe('create', () => {
    it('新しい問題を作成できるべき', async () => {
      const problem = createMockProblem();
      const created = await repository.create(problem);

      expect(created.id).toBe(problem.id);
      expect(created.title).toBe(problem.title);
    });

    it('同じIDの問題を重複して作成できないべき', async () => {
      const problem = createMockProblem();
      await repository.create(problem);

      await expect(repository.create(problem)).rejects.toThrow(
        "Problem with id 'test-problem-1' already exists"
      );
    });
  });

  describe('update', () => {
    it('既存の問題を更新できるべき', async () => {
      const problem = createMockProblem();
      await repository.create(problem);

      const updated = await repository.update('test-problem-1', {
        title: '更新後タイトル',
      });

      expect(updated.title).toBe('更新後タイトル');
      expect(updated.id).toBe('test-problem-1');
    });

    it('存在しない問題を更新しようとするとエラーになるべき', async () => {
      await expect(
        repository.update('non-existent', { title: 'test' })
      ).rejects.toThrow("Problem with id 'non-existent' not found");
    });

    it('更新時にIDを変更しようとしても元のIDが維持されるべき', async () => {
      const problem = createMockProblem();
      await repository.create(problem);

      const updated = await repository.update('test-problem-1', {
        id: 'new-id',
        title: '更新後タイトル',
      } as Partial<Problem>);

      expect(updated.id).toBe('test-problem-1');
    });
  });

  describe('delete', () => {
    it('既存の問題を削除できるべき', async () => {
      const problem = createMockProblem();
      await repository.create(problem);

      await repository.delete('test-problem-1');

      const found = await repository.findById('test-problem-1');
      expect(found).toBeNull();
    });

    it('存在しない問題を削除しようとするとエラーになるべき', async () => {
      await expect(repository.delete('non-existent')).rejects.toThrow(
        "Problem with id 'non-existent' not found"
      );
    });
  });

  describe('findById', () => {
    it('IDで問題を取得できるべき', async () => {
      const problem = createMockProblem();
      await repository.create(problem);

      const found = await repository.findById('test-problem-1');

      expect(found).not.toBeNull();
      expect(found?.id).toBe('test-problem-1');
    });

    it('存在しないIDの場合はnullを返すべき', async () => {
      const found = await repository.findById('non-existent');
      expect(found).toBeNull();
    });
  });

  describe('findAll', () => {
    beforeEach(async () => {
      await repository.create(createMockProblem({ id: 'problem-1', type: 'gameday', category: 'architecture', difficulty: 'easy' }));
      await repository.create(createMockProblem({ id: 'problem-2', type: 'jam', category: 'security', difficulty: 'medium' }));
      await repository.create(createMockProblem({ id: 'problem-3', type: 'gameday', category: 'architecture', difficulty: 'hard' }));
    });

    it('全ての問題を取得できるべき', async () => {
      const problems = await repository.findAll();
      expect(problems).toHaveLength(3);
    });

    it('タイプでフィルタリングできるべき', async () => {
      const problems = await repository.findAll({ type: 'gameday' });
      expect(problems).toHaveLength(2);
      expect(problems.every(p => p.type === 'gameday')).toBe(true);
    });

    it('カテゴリでフィルタリングできるべき', async () => {
      const problems = await repository.findAll({ category: 'architecture' });
      expect(problems).toHaveLength(2);
      expect(problems.every(p => p.category === 'architecture')).toBe(true);
    });

    it('難易度でフィルタリングできるべき', async () => {
      const problems = await repository.findAll({ difficulty: 'medium' });
      expect(problems).toHaveLength(1);
      expect(problems[0].difficulty).toBe('medium');
    });

    it('作成者でフィルタリングできるべき', async () => {
      const problems = await repository.findAll({ author: 'test-author' });
      expect(problems).toHaveLength(3);
    });

    it('タグでフィルタリングできるべき', async () => {
      const problems = await repository.findAll({ tags: ['aws'] });
      expect(problems).toHaveLength(3);
    });

    it('存在しないタグでフィルタリングすると空配列を返すべき', async () => {
      const problems = await repository.findAll({ tags: ['non-existent-tag'] });
      expect(problems).toHaveLength(0);
    });

    it('ページネーションが動作するべき', async () => {
      const page1 = await repository.findAll({ limit: 2, offset: 0 });
      const page2 = await repository.findAll({ limit: 2, offset: 2 });

      expect(page1).toHaveLength(2);
      expect(page2).toHaveLength(1);
    });
  });

  describe('count', () => {
    it('問題数を取得できるべき', async () => {
      await repository.create(createMockProblem({ id: 'problem-1' }));
      await repository.create(createMockProblem({ id: 'problem-2' }));

      const count = await repository.count();
      expect(count).toBe(2);
    });

    it('フィルター付きで問題数を取得できるべき', async () => {
      await repository.create(createMockProblem({ id: 'problem-1', type: 'gameday' }));
      await repository.create(createMockProblem({ id: 'problem-2', type: 'jam' }));

      const count = await repository.count({ type: 'gameday' });
      expect(count).toBe(1);
    });
  });

  describe('exists', () => {
    it('存在する問題はtrueを返すべき', async () => {
      await repository.create(createMockProblem());
      const exists = await repository.exists('test-problem-1');
      expect(exists).toBe(true);
    });

    it('存在しない問題はfalseを返すべき', async () => {
      const exists = await repository.exists('non-existent');
      expect(exists).toBe(false);
    });
  });

  describe('clear', () => {
    it('全ての問題をクリアできるべき', async () => {
      await repository.create(createMockProblem({ id: 'problem-1' }));
      await repository.create(createMockProblem({ id: 'problem-2' }));

      repository.clear();

      const count = await repository.count();
      expect(count).toBe(0);
    });
  });
});

describe('InMemoryMarketplaceRepository', () => {
  let problemRepository: InMemoryProblemRepository;
  let marketplaceRepository: InMemoryMarketplaceRepository;

  beforeEach(() => {
    problemRepository = new InMemoryProblemRepository();
    marketplaceRepository = new InMemoryMarketplaceRepository(problemRepository);
  });

  describe('publish', () => {
    it('問題をマーケットプレイスに公開できるべき', async () => {
      const problem = createMockProblem();
      await problemRepository.create(problem);

      const published = await marketplaceRepository.publish('test-problem-1');

      expect(published.marketplaceId).toBe('mp-test-problem-1');
      expect(published.status).toBe('published');
      expect(published.downloadCount).toBe(0);
      expect(published.publishedAt).toBeInstanceOf(Date);
    });

    it('存在しない問題を公開しようとするとエラーになるべき', async () => {
      await expect(marketplaceRepository.publish('non-existent')).rejects.toThrow(
        "Problem with id 'non-existent' not found"
      );
    });
  });

  describe('unpublish', () => {
    it('マーケットプレイス問題を非公開にできるべき', async () => {
      const problem = createMockProblem();
      await problemRepository.create(problem);
      await marketplaceRepository.publish('test-problem-1');

      await marketplaceRepository.unpublish('mp-test-problem-1');

      const found = await marketplaceRepository.findById('mp-test-problem-1');
      expect(found?.status).toBe('archived');
    });

    it('存在しないマーケットプレイス問題を非公開にしようとするとエラーになるべき', async () => {
      await expect(marketplaceRepository.unpublish('non-existent')).rejects.toThrow(
        "Marketplace problem with id 'non-existent' not found"
      );
    });
  });

  describe('search', () => {
    beforeEach(async () => {
      await problemRepository.create(createMockProblem({
        id: 'problem-1',
        title: 'EC2 入門',
        type: 'gameday',
        category: 'architecture',
        difficulty: 'easy',
        metadata: { author: 'test', version: '1.0.0', createdAt: '2024-01-01', tags: ['aws', 'ec2'] },
      }));
      await problemRepository.create(createMockProblem({
        id: 'problem-2',
        title: 'S3 セキュリティ',
        type: 'jam',
        category: 'security',
        difficulty: 'medium',
        metadata: { author: 'test', version: '1.0.0', createdAt: '2024-01-01', tags: ['aws', 's3'] },
      }));
      await problemRepository.create(createMockProblem({
        id: 'problem-3',
        title: 'Lambda パフォーマンス',
        type: 'gameday',
        category: 'performance',
        difficulty: 'hard',
        metadata: { author: 'test', version: '1.0.0', createdAt: '2024-01-01', tags: ['aws', 'lambda'] },
      }));

      await marketplaceRepository.publish('problem-1');
      await marketplaceRepository.publish('problem-2');
      await marketplaceRepository.publish('problem-3');
    });

    it('全ての公開問題を検索できるべき', async () => {
      const result = await marketplaceRepository.search({});
      expect(result.problems).toHaveLength(3);
      expect(result.total).toBe(3);
    });

    it('テキストクエリで検索できるべき', async () => {
      const result = await marketplaceRepository.search({ query: 'EC2' });
      expect(result.problems).toHaveLength(1);
      expect(result.problems[0].title).toBe('EC2 入門');
    });

    it('タイプでフィルタリングできるべき', async () => {
      const result = await marketplaceRepository.search({ type: 'gameday' });
      expect(result.problems).toHaveLength(2);
    });

    it('カテゴリでフィルタリングできるべき', async () => {
      const result = await marketplaceRepository.search({ category: 'security' });
      expect(result.problems).toHaveLength(1);
    });

    it('難易度でフィルタリングできるべき', async () => {
      const result = await marketplaceRepository.search({ difficulty: 'hard' });
      expect(result.problems).toHaveLength(1);
    });

    it('プロバイダーでフィルタリングできるべき', async () => {
      const result = await marketplaceRepository.search({ provider: 'aws' });
      expect(result.problems).toHaveLength(3);
    });

    it('タグでフィルタリングできるべき', async () => {
      const result = await marketplaceRepository.search({ tags: ['lambda'] });
      expect(result.problems).toHaveLength(1);
    });

    it('ページネーションが動作するべき', async () => {
      const result = await marketplaceRepository.search({ limit: 2, page: 1 });
      expect(result.problems).toHaveLength(2);
      expect(result.hasMore).toBe(true);

      const result2 = await marketplaceRepository.search({ limit: 2, page: 2 });
      expect(result2.problems).toHaveLength(1);
      expect(result2.hasMore).toBe(false);
    });

    it('ダウンロード数でソートできるべき', async () => {
      // ダウンロード数を設定
      await marketplaceRepository.incrementDownloads('mp-problem-2');
      await marketplaceRepository.incrementDownloads('mp-problem-2');
      await marketplaceRepository.incrementDownloads('mp-problem-1');

      const result = await marketplaceRepository.search({ sortBy: 'downloads' });
      expect(result.problems[0].marketplaceId).toBe('mp-problem-2');
    });

    it('非公開の問題は検索結果に含まれないべき', async () => {
      await marketplaceRepository.unpublish('mp-problem-1');

      const result = await marketplaceRepository.search({});
      expect(result.problems).toHaveLength(2);
      expect(result.problems.every(p => p.marketplaceId !== 'mp-problem-1')).toBe(true);
    });
  });

  describe('findById', () => {
    it('IDでマーケットプレイス問題を取得できるべき', async () => {
      await problemRepository.create(createMockProblem());
      await marketplaceRepository.publish('test-problem-1');

      const found = await marketplaceRepository.findById('mp-test-problem-1');
      expect(found).not.toBeNull();
      expect(found?.marketplaceId).toBe('mp-test-problem-1');
    });

    it('存在しないIDの場合はnullを返すべき', async () => {
      const found = await marketplaceRepository.findById('non-existent');
      expect(found).toBeNull();
    });
  });

  describe('incrementDownloads', () => {
    it('ダウンロード数をインクリメントできるべき', async () => {
      await problemRepository.create(createMockProblem());
      await marketplaceRepository.publish('test-problem-1');

      await marketplaceRepository.incrementDownloads('mp-test-problem-1');
      await marketplaceRepository.incrementDownloads('mp-test-problem-1');

      const found = await marketplaceRepository.findById('mp-test-problem-1');
      expect(found?.downloadCount).toBe(2);
    });

    it('存在しない問題のダウンロード数をインクリメントしても何も起こらないべき', async () => {
      // エラーにならずに実行される
      await marketplaceRepository.incrementDownloads('non-existent');
    });
  });

  describe('addReview', () => {
    it('レビューを追加できるべき', async () => {
      await problemRepository.create(createMockProblem());
      await marketplaceRepository.publish('test-problem-1');

      await marketplaceRepository.addReview('mp-test-problem-1', {
        userId: 'user-1',
        userName: 'テストユーザー',
        rating: 5,
        comment: '素晴らしい問題です',
      });

      const found = await marketplaceRepository.findById('mp-test-problem-1');
      expect(found?.reviews).toHaveLength(1);
      expect(found?.reviews?.[0].rating).toBe(5);
      expect(found?.rating).toBe(5);
    });

    it('複数のレビューで平均評価が計算されるべき', async () => {
      await problemRepository.create(createMockProblem());
      await marketplaceRepository.publish('test-problem-1');

      await marketplaceRepository.addReview('mp-test-problem-1', {
        userId: 'user-1',
        userName: 'ユーザー1',
        rating: 5,
        comment: 'コメント1',
      });

      await marketplaceRepository.addReview('mp-test-problem-1', {
        userId: 'user-2',
        userName: 'ユーザー2',
        rating: 3,
        comment: 'コメント2',
      });

      const found = await marketplaceRepository.findById('mp-test-problem-1');
      expect(found?.reviews).toHaveLength(2);
      expect(found?.rating).toBe(4); // (5 + 3) / 2 = 4
    });

    it('存在しない問題にレビューを追加しようとするとエラーになるべき', async () => {
      await expect(
        marketplaceRepository.addReview('non-existent', {
          userId: 'user-1',
          userName: 'テスト',
          rating: 5,
          comment: 'テスト',
        })
      ).rejects.toThrow("Marketplace problem with id 'non-existent' not found");
    });
  });

  describe('clear', () => {
    it('全てのマーケットプレイス問題をクリアできるべき', async () => {
      await problemRepository.create(createMockProblem());
      await marketplaceRepository.publish('test-problem-1');

      marketplaceRepository.clear();

      const found = await marketplaceRepository.findById('mp-test-problem-1');
      expect(found).toBeNull();
    });
  });
});
