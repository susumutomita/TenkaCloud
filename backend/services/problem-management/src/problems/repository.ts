/**
 * Problem Repository
 *
 * 問題の永続化とクエリを担当するリポジトリ
 */

import type {
  DifficultyLevel,
  MarketplaceProblem,
  MarketplaceSearchQuery,
  MarketplaceSearchResult,
  Problem,
  ProblemCategory,
  ProblemType,
} from '../types';

/**
 * 問題リポジトリインターフェース
 */
export interface IProblemRepository {
  /**
   * 問題の作成
   * @param problem 問題データ
   * @returns 作成された問題
   */
  create(problem: Problem): Promise<Problem>;

  /**
   * 問題の更新
   * @param id 問題ID
   * @param updates 更新データ
   * @returns 更新された問題
   */
  update(id: string, updates: Partial<Problem>): Promise<Problem>;

  /**
   * 問題の削除
   * @param id 問題ID
   */
  delete(id: string): Promise<void>;

  /**
   * 問題の取得
   * @param id 問題ID
   * @returns 問題（存在しない場合は null）
   */
  findById(id: string): Promise<Problem | null>;

  /**
   * 問題一覧の取得
   * @param options フィルターオプション
   * @returns 問題一覧
   */
  findAll(options?: ProblemFilterOptions): Promise<Problem[]>;

  /**
   * 問題数の取得
   * @param options フィルターオプション
   * @returns 問題数
   */
  count(options?: ProblemFilterOptions): Promise<number>;

  /**
   * 問題の存在確認
   * @param id 問題ID
   * @returns 存在する場合 true
   */
  exists(id: string): Promise<boolean>;
}

/**
 * 問題フィルターオプション
 */
export interface ProblemFilterOptions {
  type?: ProblemType;
  category?: ProblemCategory;
  difficulty?: DifficultyLevel;
  tags?: string[];
  author?: string;
  limit?: number;
  offset?: number;
}

/**
 * マーケットプレイスリポジトリインターフェース
 */
export interface IMarketplaceRepository {
  /**
   * 問題の公開
   * @param problemId 問題ID
   * @returns 公開されたマーケットプレイス問題
   */
  publish(problemId: string): Promise<MarketplaceProblem>;

  /**
   * 問題の非公開化
   * @param marketplaceId マーケットプレイスID
   */
  unpublish(marketplaceId: string): Promise<void>;

  /**
   * マーケットプレイス問題の検索
   * @param query 検索クエリ
   * @returns 検索結果
   */
  search(query: MarketplaceSearchQuery): Promise<MarketplaceSearchResult>;

  /**
   * マーケットプレイス問題の取得
   * @param marketplaceId マーケットプレイスID
   * @returns マーケットプレイス問題
   */
  findById(marketplaceId: string): Promise<MarketplaceProblem | null>;

  /**
   * ダウンロード数のインクリメント
   * @param marketplaceId マーケットプレイスID
   */
  incrementDownloads(marketplaceId: string): Promise<void>;

  /**
   * レビューの追加
   * @param marketplaceId マーケットプレイスID
   * @param review レビューデータ
   */
  addReview(
    marketplaceId: string,
    review: {
      userId: string;
      userName: string;
      rating: number;
      comment: string;
    }
  ): Promise<void>;
}

/**
 * インメモリ問題リポジトリ実装（開発・テスト用）
 */
export class InMemoryProblemRepository implements IProblemRepository {
  private problems: Map<string, Problem> = new Map();

  async create(problem: Problem): Promise<Problem> {
    if (this.problems.has(problem.id)) {
      throw new Error(`Problem with id '${problem.id}' already exists`);
    }
    this.problems.set(problem.id, { ...problem });
    return problem;
  }

  async update(id: string, updates: Partial<Problem>): Promise<Problem> {
    const existing = this.problems.get(id);
    if (!existing) {
      throw new Error(`Problem with id '${id}' not found`);
    }
    const updated = { ...existing, ...updates, id }; // id は変更不可
    this.problems.set(id, updated);
    return updated;
  }

  async delete(id: string): Promise<void> {
    if (!this.problems.has(id)) {
      throw new Error(`Problem with id '${id}' not found`);
    }
    this.problems.delete(id);
  }

  async findById(id: string): Promise<Problem | null> {
    return this.problems.get(id) || null;
  }

  async findAll(options?: ProblemFilterOptions): Promise<Problem[]> {
    let results = Array.from(this.problems.values());

    // フィルタリング
    if (options?.type) {
      results = results.filter((p) => p.type === options.type);
    }
    if (options?.category) {
      results = results.filter((p) => p.category === options.category);
    }
    if (options?.difficulty) {
      results = results.filter((p) => p.difficulty === options.difficulty);
    }
    if (options?.author) {
      results = results.filter((p) => p.metadata.author === options.author);
    }
    if (options?.tags && options.tags.length > 0) {
      results = results.filter((p) =>
        options.tags!.some((tag) => p.metadata.tags?.includes(tag))
      );
    }

    // ページネーション
    const offset = options?.offset || 0;
    const limit = options?.limit || 100;
    results = results.slice(offset, offset + limit);

    return results;
  }

  async count(options?: ProblemFilterOptions): Promise<number> {
    const results = await this.findAll({
      ...options,
      limit: undefined,
      offset: undefined,
    });
    return results.length;
  }

  async exists(id: string): Promise<boolean> {
    return this.problems.has(id);
  }

  // テスト用ヘルパー
  clear(): void {
    this.problems.clear();
  }
}

/**
 * インメモリマーケットプレイスリポジトリ実装（開発・テスト用）
 */
export class InMemoryMarketplaceRepository implements IMarketplaceRepository {
  private marketplaceProblems: Map<string, MarketplaceProblem> = new Map();
  private problemRepository: IProblemRepository;

  constructor(problemRepository: IProblemRepository) {
    this.problemRepository = problemRepository;
  }

  async publish(problemId: string): Promise<MarketplaceProblem> {
    const problem = await this.problemRepository.findById(problemId);
    if (!problem) {
      throw new Error(`Problem with id '${problemId}' not found`);
    }

    const marketplaceId = `mp-${problemId}`;
    const marketplaceProblem: MarketplaceProblem = {
      ...problem,
      marketplaceId,
      status: 'published',
      publishedAt: new Date(),
      downloadCount: 0,
      reviews: [],
    };

    this.marketplaceProblems.set(marketplaceId, marketplaceProblem);
    return marketplaceProblem;
  }

  async unpublish(marketplaceId: string): Promise<void> {
    const problem = this.marketplaceProblems.get(marketplaceId);
    if (!problem) {
      throw new Error(
        `Marketplace problem with id '${marketplaceId}' not found`
      );
    }
    problem.status = 'archived';
    this.marketplaceProblems.set(marketplaceId, problem);
  }

  async search(
    query: MarketplaceSearchQuery
  ): Promise<MarketplaceSearchResult> {
    let results = Array.from(this.marketplaceProblems.values()).filter(
      (p) => p.status === 'published'
    );

    // テキスト検索
    if (query.query) {
      const q = query.query.toLowerCase();
      results = results.filter(
        (p) =>
          p.title.toLowerCase().includes(q) ||
          p.description.overview.toLowerCase().includes(q) ||
          p.metadata.tags?.some((tag) => tag.toLowerCase().includes(q))
      );
    }

    // フィルタリング
    if (query.type) {
      results = results.filter((p) => p.type === query.type);
    }
    if (query.category) {
      results = results.filter((p) => p.category === query.category);
    }
    if (query.difficulty) {
      results = results.filter((p) => p.difficulty === query.difficulty);
    }
    if (query.provider) {
      results = results.filter((p) =>
        p.deployment.providers.includes(query.provider!)
      );
    }
    if (query.tags && query.tags.length > 0) {
      results = results.filter((p) =>
        query.tags!.some((tag) => p.metadata.tags?.includes(tag))
      );
    }

    // ソート
    switch (query.sortBy) {
      case 'rating':
        results.sort((a, b) => (b.rating || 0) - (a.rating || 0));
        break;
      case 'downloads':
        results.sort((a, b) => b.downloadCount - a.downloadCount);
        break;
      case 'newest':
        results.sort(
          (a, b) =>
            (b.publishedAt?.getTime() || 0) - (a.publishedAt?.getTime() || 0)
        );
        break;
      case 'relevance':
      default:
        // デフォルトはダウンロード数でソート
        results.sort((a, b) => b.downloadCount - a.downloadCount);
        break;
    }

    // ページネーション
    const page = query.page || 1;
    const limit = query.limit || 20;
    const offset = (page - 1) * limit;
    const total = results.length;
    const paginatedResults = results.slice(offset, offset + limit);

    return {
      problems: paginatedResults,
      total,
      page,
      limit,
      hasMore: offset + limit < total,
    };
  }

  async findById(marketplaceId: string): Promise<MarketplaceProblem | null> {
    return this.marketplaceProblems.get(marketplaceId) || null;
  }

  async incrementDownloads(marketplaceId: string): Promise<void> {
    const problem = this.marketplaceProblems.get(marketplaceId);
    if (problem) {
      problem.downloadCount++;
      this.marketplaceProblems.set(marketplaceId, problem);
    }
  }

  async addReview(
    marketplaceId: string,
    review: {
      userId: string;
      userName: string;
      rating: number;
      comment: string;
    }
  ): Promise<void> {
    const problem = this.marketplaceProblems.get(marketplaceId);
    if (!problem) {
      throw new Error(
        `Marketplace problem with id '${marketplaceId}' not found`
      );
    }

    const newReview = {
      id: `review-${Date.now()}`,
      ...review,
      createdAt: new Date(),
    };

    problem.reviews = problem.reviews || [];
    problem.reviews.push(newReview);

    // 平均評価を更新
    const totalRating = problem.reviews.reduce((sum, r) => sum + r.rating, 0);
    problem.rating = totalRating / problem.reviews.length;

    this.marketplaceProblems.set(marketplaceId, problem);
  }

  // テスト用ヘルパー
  clear(): void {
    this.marketplaceProblems.clear();
  }
}
