'use client';

import { useEffect, useState, useCallback } from 'react';
import { MarketplaceHeader } from '@/components/problems/marketplace-header';
import { ProblemCard } from '@/components/problems/problem-card';
import { ProblemFilters } from '@/components/problems/problem-filters';
import { Button } from '@/components/ui/button';
import {
  searchMarketplaceProblems,
  getFeaturedProblems,
  installProblem,
  type MarketplaceProblem,
  type MarketplaceSearchParams,
} from '@/lib/api/problems';

export default function MarketplacePage() {
  const [problems, setProblems] = useState<MarketplaceProblem[]>([]);
  const [featuredProblems, setFeaturedProblems] = useState<MarketplaceProblem[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState<string | null>(null);

  const [filters, setFilters] = useState<MarketplaceSearchParams>({
    page: 1,
    limit: 9,
    sortBy: 'relevance',
  });

  const loadProblems = useCallback(async () => {
    setLoading(true);
    try {
      const result = await searchMarketplaceProblems(filters);
      setProblems(result.problems);
      setTotal(result.total);
      setTotalPages(result.totalPages);
    } catch (error) {
      console.error('Failed to load problems:', error);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  const loadFeatured = useCallback(async () => {
    try {
      const featured = await getFeaturedProblems();
      setFeaturedProblems(featured);
    } catch (error) {
      console.error('Failed to load featured problems:', error);
    }
  }, []);

  useEffect(() => {
    loadProblems();
  }, [loadProblems]);

  useEffect(() => {
    loadFeatured();
  }, [loadFeatured]);

  const handleInstall = async (problemId: string) => {
    setInstalling(problemId);
    try {
      const result = await installProblem(problemId);
      if (result.success) {
        alert(`問題をインストールしました (ID: ${result.installedId})`);
      }
    } catch (error) {
      console.error('Failed to install problem:', error);
      alert('インストールに失敗しました');
    } finally {
      setInstalling(null);
    }
  };

  const handleViewDetails = (problemId: string) => {
    // TODO: 問題詳細モーダルまたはページに遷移
    console.log('View details:', problemId);
  };

  const handleFiltersChange = (newFilters: MarketplaceSearchParams) => {
    setFilters(newFilters);
  };

  const handleResetFilters = () => {
    setFilters({
      page: 1,
      limit: 9,
      sortBy: 'relevance',
    });
  };

  const handlePageChange = (page: number) => {
    setFilters((prev) => ({ ...prev, page }));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <div className="container mx-auto px-4 py-8">
      <MarketplaceHeader
        totalProblems={total}
        featuredCount={featuredProblems.length}
      />

      <div className="flex flex-col lg:flex-row gap-6">
        {/* サイドバー: フィルター */}
        <aside className="w-full lg:w-64 flex-shrink-0">
          <ProblemFilters
            filters={filters}
            onFiltersChange={handleFiltersChange}
            onReset={handleResetFilters}
          />
        </aside>

        {/* メインコンテンツ */}
        <main className="flex-1">
          {/* 結果数とソート */}
          <div className="flex items-center justify-between mb-4">
            <p className="text-sm text-muted-foreground">
              {total} 件の問題が見つかりました
            </p>
          </div>

          {/* 問題グリッド */}
          {loading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {[...Array(6)].map((_, i) => (
                <div
                  key={i}
                  className="h-80 bg-gray-100 animate-pulse rounded-lg"
                />
              ))}
            </div>
          ) : problems.length === 0 ? (
            <div className="text-center py-12">
              <svg
                className="mx-auto h-12 w-12 text-gray-400"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              <h3 className="mt-2 text-sm font-medium text-gray-900">
                問題が見つかりませんでした
              </h3>
              <p className="mt-1 text-sm text-gray-500">
                フィルターを変更してお試しください
              </p>
              <Button
                variant="outline"
                className="mt-4"
                onClick={handleResetFilters}
              >
                フィルターをリセット
              </Button>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {problems.map((problem) => (
                <ProblemCard
                  key={problem.id}
                  problem={problem}
                  onInstall={handleInstall}
                  onViewDetails={handleViewDetails}
                />
              ))}
            </div>
          )}

          {/* ページネーション */}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2 mt-8">
              <Button
                variant="outline"
                size="sm"
                disabled={filters.page === 1}
                onClick={() => handlePageChange((filters.page ?? 1) - 1)}
              >
                前へ
              </Button>
              {[...Array(totalPages)].map((_, i) => (
                <Button
                  key={i + 1}
                  variant={filters.page === i + 1 ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => handlePageChange(i + 1)}
                >
                  {i + 1}
                </Button>
              ))}
              <Button
                variant="outline"
                size="sm"
                disabled={filters.page === totalPages}
                onClick={() => handlePageChange((filters.page ?? 1) + 1)}
              >
                次へ
              </Button>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
