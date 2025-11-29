/**
 * Problems API Client
 *
 * 問題管理 API クライアント
 */

import { get, post } from './client';

// =============================================================================
// Types
// =============================================================================

export type ProblemType = 'gameday' | 'jam';
export const PROBLEM_TYPES: readonly ProblemType[] = [
  'gameday',
  'jam',
] as const;

export type ProblemCategory =
  | 'architecture'
  | 'security'
  | 'cost'
  | 'performance'
  | 'reliability'
  | 'operations';
export type DifficultyLevel = 'easy' | 'medium' | 'hard' | 'expert';
export type CloudProvider = 'aws' | 'gcp' | 'azure' | 'local';

export interface Problem {
  id: string;
  title: string;
  type: ProblemType;
  category: ProblemCategory;
  difficulty: DifficultyLevel;
  author: string;
  version: string;
  tags: string[];
  overview: string;
  objectives: string[];
  providers: CloudProvider[];
  estimatedTimeMinutes?: number;
  createdAt: string;
  updatedAt: string;
}

export interface MarketplaceProblem extends Problem {
  publisherName: string;
  isVerified: boolean;
  isFeatured: boolean;
  downloadCount: number;
  averageRating: number;
  reviewCount: number;
}

export interface MarketplaceSearchParams {
  query?: string;
  type?: ProblemType;
  category?: ProblemCategory;
  difficulty?: DifficultyLevel;
  provider?: CloudProvider;
  minRating?: number;
  sortBy?: 'relevance' | 'rating' | 'downloads' | 'newest';
  page?: number;
  limit?: number;
}

export interface MarketplaceSearchResult {
  problems: MarketplaceProblem[];
  total: number;
  page: number;
  totalPages: number;
}

export interface ProblemReview {
  id: string;
  userId: string;
  userName: string;
  rating: number;
  comment?: string;
  createdAt: string;
}

// =============================================================================
// API Functions
// =============================================================================

/**
 * 問題一覧を取得（テナント内）
 */
export async function getProblems(options?: {
  type?: ProblemType;
  category?: ProblemCategory;
  difficulty?: DifficultyLevel;
  provider?: CloudProvider;
  limit?: number;
  offset?: number;
}): Promise<{ problems: Problem[]; total: number }> {
  const params: Record<string, string | number | boolean | undefined> = {};

  if (options?.type) {
    params.type = options.type;
  }
  if (options?.category) {
    params.category = options.category;
  }
  if (options?.difficulty) {
    params.difficulty = options.difficulty;
  }
  if (options?.provider) {
    params.provider = options.provider;
  }
  if (options?.limit !== undefined) {
    params.limit = options.limit;
  }
  if (options?.offset !== undefined) {
    params.offset = options.offset;
  }

  return get<{ problems: Problem[]; total: number }>('/admin/problems', params);
}

/**
 * 問題の詳細を取得
 */
export async function getProblemDetails(id: string): Promise<Problem | null> {
  try {
    return await get<Problem>(`/admin/problems/${id}`);
  } catch (error) {
    if (error instanceof Error && error.message.includes('404')) {
      return null;
    }
    throw error;
  }
}

/**
 * マーケットプレイスの問題を検索
 */
export async function searchMarketplaceProblems(
  params: MarketplaceSearchParams
): Promise<MarketplaceSearchResult> {
  const queryParams: Record<string, string | number | boolean | undefined> = {};

  if (params.query) {
    queryParams.query = params.query;
  }
  if (params.type) {
    queryParams.type = params.type;
  }
  if (params.category) {
    queryParams.category = params.category;
  }
  if (params.difficulty) {
    queryParams.difficulty = params.difficulty;
  }
  if (params.provider) {
    queryParams.provider = params.provider;
  }
  if (params.minRating !== undefined) {
    queryParams.minRating = params.minRating;
  }
  if (params.sortBy) {
    queryParams.sortBy = params.sortBy;
  }
  if (params.page !== undefined) {
    queryParams.page = params.page;
  }
  if (params.limit !== undefined) {
    queryParams.limit = params.limit;
  }

  return get<MarketplaceSearchResult>('/admin/marketplace', queryParams);
}

/**
 * 問題のレビューを取得
 */
export async function getProblemReviews(
  problemId: string
): Promise<ProblemReview[]> {
  return get<ProblemReview[]>(`/admin/marketplace/${problemId}/reviews`);
}

/**
 * 問題をインストール（マーケットプレイスからテナントにコピー）
 */
export async function installProblem(
  marketplaceId: string
): Promise<{ success: boolean; installedId: string }> {
  return post<{ success: boolean; installedId: string }>(
    `/admin/marketplace/${marketplaceId}/install`
  );
}

/**
 * フィーチャー問題を取得
 */
export async function getFeaturedProblems(): Promise<MarketplaceProblem[]> {
  const result = await get<MarketplaceSearchResult>('/admin/marketplace', {
    featured: true,
    limit: 10,
  });
  return result.problems;
}

/**
 * カテゴリ別の問題数を取得
 */
export async function getCategoryCounts(): Promise<
  Record<ProblemCategory, number>
> {
  return get<Record<ProblemCategory, number>>(
    '/admin/problems/categories/counts'
  );
}
