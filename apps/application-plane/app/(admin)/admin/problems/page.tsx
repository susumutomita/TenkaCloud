/**
 * Admin Problems Page
 *
 * HybridNext Design System - Terminal Command Center style
 * 問題管理画面 - 問題の一覧表示、作成、編集、デプロイ
 */

'use client';

import Link from 'next/link';
import { useEffect, useId, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  CategoryBadge,
  DifficultyBadge,
  getCategoryIcon,
  Input,
  ProblemTypeBadge,
  ProviderBadge,
  Select,
} from '@/components/ui';
import { deleteProblem, getProblems } from '@/lib/api/admin-problems';
import type { AdminProblem, AdminProblemFilters } from '@/lib/api/admin-types';
import type {
  DifficultyLevel,
  ProblemCategory,
  ProblemType,
} from '@/lib/api/types';

export default function AdminProblemsPage() {
  const [problems, setProblems] = useState<AdminProblem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedType, setSelectedType] = useState<string>('');
  const [selectedCategory, setSelectedCategory] = useState<string>('');
  const [selectedDifficulty, setSelectedDifficulty] = useState<string>('');

  const searchInputId = useId();
  const typeFilterId = useId();
  const categoryFilterId = useId();
  const difficultyFilterId = useId();

  const fetchProblems = async () => {
    try {
      setLoading(true);
      setError(null);
      const filters: AdminProblemFilters = {};
      if (selectedType) filters.type = selectedType as ProblemType;
      if (selectedCategory)
        filters.category = selectedCategory as ProblemCategory;
      if (selectedDifficulty)
        filters.difficulty = selectedDifficulty as DifficultyLevel;

      const result = await getProblems({ ...filters, limit: 100 });
      setProblems(result.problems);
      setTotal(result.total);
    } catch (err) {
      console.error('Failed to fetch problems:', err);
      setError('問題の取得に失敗しました');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchProblems();
  }, [selectedType, selectedCategory, selectedDifficulty]);

  const handleDelete = async (problemId: string, title: string) => {
    if (!confirm(`「${title}」を削除しますか？この操作は取り消せません。`)) {
      return;
    }

    try {
      await deleteProblem(problemId);
      fetchProblems();
    } catch (err) {
      console.error('Failed to delete problem:', err);
      alert('問題の削除に失敗しました');
    }
  };

  const filteredProblems = problems.filter((p) => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return (
      p.title.toLowerCase().includes(query) ||
      p.description.overview.toLowerCase().includes(query) ||
      p.metadata.tags.some((tag) => tag.toLowerCase().includes(query))
    );
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-text-primary flex items-center gap-3">
          <span className="text-hn-accent font-mono">&gt;_</span>
          問題管理
        </h1>
        <Button asChild>
          <Link href="/admin/problems/new">
            <svg
              className="w-5 h-5 mr-2"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 4v16m8-8H4"
              />
            </svg>
            新規問題作成
          </Link>
        </Button>
      </div>

      {/* Search & Filters */}
      <Card>
        <CardContent className="p-4">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
            <div className="lg:col-span-2">
              <label htmlFor={searchInputId} className="sr-only">
                検索
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <svg
                    className="h-5 w-5 text-text-muted"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                    />
                  </svg>
                </div>
                <Input
                  id={searchInputId}
                  type="text"
                  placeholder="タイトル、説明、タグで検索..."
                  className="pl-10"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
            </div>

            <div>
              <label
                htmlFor={typeFilterId}
                className="block text-xs font-medium text-text-muted mb-1"
              >
                タイプ
              </label>
              <Select
                id={typeFilterId}
                value={selectedType}
                onChange={(e) => setSelectedType(e.target.value)}
                options={[
                  { value: '', label: 'すべて' },
                  { value: 'gameday', label: 'Incident Drill' },
                  { value: 'jam', label: 'Challenge' },
                ]}
              />
            </div>

            <div>
              <label
                htmlFor={categoryFilterId}
                className="block text-xs font-medium text-text-muted mb-1"
              >
                カテゴリ
              </label>
              <Select
                id={categoryFilterId}
                value={selectedCategory}
                onChange={(e) => setSelectedCategory(e.target.value)}
                options={[
                  { value: '', label: 'すべて' },
                  { value: 'architecture', label: 'アーキテクチャ' },
                  { value: 'security', label: 'セキュリティ' },
                  { value: 'cost', label: 'コスト最適化' },
                  { value: 'performance', label: 'パフォーマンス' },
                  { value: 'reliability', label: '信頼性' },
                  { value: 'operations', label: '運用' },
                ]}
              />
            </div>

            <div>
              <label
                htmlFor={difficultyFilterId}
                className="block text-xs font-medium text-text-muted mb-1"
              >
                難易度
              </label>
              <Select
                id={difficultyFilterId}
                value={selectedDifficulty}
                onChange={(e) => setSelectedDifficulty(e.target.value)}
                options={[
                  { value: '', label: 'すべて' },
                  { value: 'easy', label: '初級' },
                  { value: 'medium', label: '中級' },
                  { value: 'hard', label: '上級' },
                  { value: 'expert', label: 'エキスパート' },
                ]}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card>
          <CardContent className="p-6">
            <div className="text-sm font-medium text-text-muted">総問題数</div>
            <div className="text-3xl font-bold text-text-primary mt-1 font-mono">
              {total}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <div className="text-sm font-medium text-text-muted">
              フィルター結果
            </div>
            <div className="text-3xl font-bold text-hn-accent mt-1 font-mono">
              {filteredProblems.length}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <div className="text-sm font-medium text-text-muted">
              AWS対応問題
            </div>
            <div className="text-3xl font-bold text-hn-warning mt-1 font-mono">
              {
                problems.filter((p) => p.deployment.providers.includes('aws'))
                  .length
              }
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Error */}
      {error && (
        <Card className="border-hn-error">
          <CardContent className="p-4 text-hn-error">{error}</CardContent>
        </Card>
      )}

      {/* Problems List */}
      {loading ? (
        <div className="space-y-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="p-6">
                <div className="flex items-start justify-between">
                  <div className="space-y-3 flex-1">
                    <Skeleton className="h-6 w-1/3" />
                    <Skeleton className="h-4 w-2/3" />
                    <div className="flex gap-2">
                      <Skeleton className="h-6 w-16" />
                      <Skeleton className="h-6 w-16" />
                      <Skeleton className="h-6 w-16" />
                    </div>
                  </div>
                  <Skeleton className="h-10 w-24" />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : filteredProblems.length === 0 ? (
        <Card className="text-center py-12">
          <div className="text-4xl mb-4">📭</div>
          <h2 className="text-xl font-semibold text-text-primary mb-2">
            問題が見つかりません
          </h2>
          <p className="text-text-muted mb-4">
            検索条件を変更するか、新しい問題を作成してください。
          </p>
          <Button asChild>
            <Link href="/admin/problems/new">新規問題を作成</Link>
          </Button>
        </Card>
      ) : (
        <div className="space-y-4">
          {filteredProblems.map((problem) => (
            <Card
              key={problem.id}
              className="group hover:border-hn-accent/50 transition-all duration-[var(--animation-duration-fast)]"
            >
              <CardContent className="p-6">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3 mb-2">
                      <span className="text-2xl">
                        {getCategoryIcon(problem.category)}
                      </span>
                      <div>
                        <Link
                          href={`/admin/problems/${problem.id}`}
                          className="text-lg font-semibold text-text-primary hover:text-hn-accent transition-colors"
                        >
                          {problem.title}
                        </Link>
                        <p className="text-sm text-text-muted font-mono">
                          {problem.metadata.author} • v
                          {problem.metadata.version}
                        </p>
                      </div>
                    </div>

                    <p className="text-sm text-text-secondary mb-4 line-clamp-2">
                      {problem.description.overview}
                    </p>

                    <div className="flex flex-wrap gap-2 mb-4">
                      <ProblemTypeBadge type={problem.type} />
                      <DifficultyBadge difficulty={problem.difficulty} />
                      <CategoryBadge category={problem.category} />
                      {problem.deployment.providers.map((provider) => (
                        <ProviderBadge key={provider} provider={provider} />
                      ))}
                    </div>

                    <div className="flex flex-wrap gap-1">
                      {problem.metadata.tags.slice(0, 5).map((tag) => (
                        <span
                          key={tag}
                          className="text-xs px-2 py-1 bg-surface-2 text-text-muted rounded-[var(--radius)] font-mono"
                        >
                          {tag}
                        </span>
                      ))}
                      {problem.metadata.tags.length > 5 && (
                        <span className="text-xs px-2 py-1 text-text-muted">
                          +{problem.metadata.tags.length - 5}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-col gap-2">
                    <Button asChild size="sm">
                      <Link href={`/admin/problems/${problem.id}`}>詳細</Link>
                    </Button>
                    {problem.deployment.providers.includes('aws') && (
                      <Button asChild variant="secondary" size="sm">
                        <Link href={`/admin/problems/${problem.id}/deploy`}>
                          デプロイ
                        </Link>
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-hn-error hover:text-hn-error hover:bg-hn-error/10"
                      onClick={() => handleDelete(problem.id, problem.title)}
                    >
                      削除
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Terminal-style footer */}
      <div className="text-center text-text-muted text-xs font-mono py-4">
        <span className="text-hn-accent">$</span> problems --list --count=
        {filteredProblems.length}
      </div>
    </div>
  );
}
