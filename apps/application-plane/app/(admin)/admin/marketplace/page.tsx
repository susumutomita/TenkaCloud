/**
 * Admin Marketplace Page
 *
 * HybridNext Design System - Terminal Command Center style
 * 問題マーケットプレイス - 問題の検索と選択
 */

'use client';

import { useEffect, useId, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge, Input, Select } from '@/components/ui';
import type {
  CloudProvider,
  DifficultyLevel,
  ProblemCategory,
  ProblemType,
} from '@/lib/api/types';

interface MarketplaceProblem {
  id: string;
  title: string;
  description: string;
  type: ProblemType;
  category: ProblemCategory;
  difficulty: DifficultyLevel;
  cloudProvider: CloudProvider;
  estimatedTimeMinutes: number;
  authorName: string;
  rating: number;
  usageCount: number;
  tags: string[];
  createdAt: string;
}

export default function AdminMarketplacePage() {
  const [problems, setProblems] = useState<MarketplaceProblem[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('');
  const [selectedDifficulty, setSelectedDifficulty] = useState<string>('');
  const [selectedCloudProvider, setSelectedCloudProvider] =
    useState<string>('');

  const searchInputId = useId();
  const categoryFilterId = useId();
  const difficultyFilterId = useId();
  const cloudProviderFilterId = useId();

  useEffect(() => {
    // TODO: Replace with actual API call
    const fetchProblems = async () => {
      try {
        setLoading(true);
        // Mock data
        setProblems([
          {
            id: 'prob-1',
            title: 'VPC ネットワーク設計',
            description:
              'マルチ AZ 構成の VPC を設計・構築し、セキュアなネットワーク環境を実現する課題です。',
            type: 'gameday',
            category: 'architecture',
            difficulty: 'medium',
            cloudProvider: 'aws',
            estimatedTimeMinutes: 45,
            authorName: 'AWS Solutions Architect',
            rating: 4.8,
            usageCount: 156,
            tags: ['VPC', 'Networking', 'Security Group'],
            createdAt: new Date(Date.now() - 2592000000).toISOString(),
          },
          {
            id: 'prob-2',
            title: 'Lambda コスト最適化',
            description:
              'Lambda 関数のメモリ設定とタイムアウトを最適化してコストを削減する課題です。',
            type: 'jam',
            category: 'cost',
            difficulty: 'easy',
            cloudProvider: 'aws',
            estimatedTimeMinutes: 30,
            authorName: 'Cloud Cost Optimizer',
            rating: 4.5,
            usageCount: 89,
            tags: ['Lambda', 'Cost Optimization', 'Serverless'],
            createdAt: new Date(Date.now() - 1296000000).toISOString(),
          },
          {
            id: 'prob-3',
            title: 'IAM セキュリティ強化',
            description:
              '最小権限の原則に基づいた IAM ポリシーを設計し、セキュリティを強化する課題です。',
            type: 'gameday',
            category: 'security',
            difficulty: 'hard',
            cloudProvider: 'aws',
            estimatedTimeMinutes: 60,
            authorName: 'Security Specialist',
            rating: 4.9,
            usageCount: 234,
            tags: ['IAM', 'Security', 'Policy'],
            createdAt: new Date(Date.now() - 604800000).toISOString(),
          },
          {
            id: 'prob-4',
            title: 'Auto Scaling 設計',
            description:
              '負荷に応じて自動スケーリングする構成を設計・実装する課題です。',
            type: 'gameday',
            category: 'performance',
            difficulty: 'medium',
            cloudProvider: 'aws',
            estimatedTimeMinutes: 50,
            authorName: 'Performance Engineer',
            rating: 4.6,
            usageCount: 178,
            tags: ['Auto Scaling', 'EC2', 'High Availability'],
            createdAt: new Date(Date.now() - 172800000).toISOString(),
          },
          {
            id: 'prob-5',
            title: 'マルチリージョン DR 構成',
            description:
              'マルチリージョンの災害復旧（DR）構成を設計・実装する上級課題です。',
            type: 'gameday',
            category: 'reliability',
            difficulty: 'expert',
            cloudProvider: 'aws',
            estimatedTimeMinutes: 90,
            authorName: 'DR Architect',
            rating: 4.7,
            usageCount: 67,
            tags: ['DR', 'Multi-Region', 'RTO/RPO'],
            createdAt: new Date(Date.now() - 86400000).toISOString(),
          },
        ]);
      } finally {
        setLoading(false);
      }
    };

    fetchProblems();
  }, []);

  const getDifficultyBadgeVariant = (
    difficulty: DifficultyLevel
  ): 'default' | 'success' | 'warning' | 'danger' | 'purple' => {
    switch (difficulty) {
      case 'easy':
        return 'success';
      case 'medium':
        return 'warning';
      case 'hard':
        return 'danger';
      case 'expert':
        return 'purple';
      default:
        return 'default';
    }
  };

  const getDifficultyLabel = (difficulty: DifficultyLevel): string => {
    switch (difficulty) {
      case 'easy':
        return '初級';
      case 'medium':
        return '中級';
      case 'hard':
        return '上級';
      case 'expert':
        return 'エキスパート';
      default:
        return difficulty;
    }
  };

  const getCategoryLabel = (category: ProblemCategory): string => {
    switch (category) {
      case 'architecture':
        return 'アーキテクチャ';
      case 'security':
        return 'セキュリティ';
      case 'cost':
        return 'コスト最適化';
      case 'performance':
        return 'パフォーマンス';
      case 'reliability':
        return '信頼性';
      case 'operations':
        return '運用';
      default:
        return category;
    }
  };

  const getCategoryIcon = (category: ProblemCategory): string => {
    switch (category) {
      case 'architecture':
        return '🏗️';
      case 'security':
        return '🔒';
      case 'cost':
        return '💰';
      case 'performance':
        return '⚡';
      case 'reliability':
        return '🛡️';
      case 'operations':
        return '🔧';
      default:
        return '📦';
    }
  };

  const filteredProblems = problems.filter((p) => {
    const matchesSearch =
      searchQuery === '' ||
      p.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.tags.some((tag) =>
        tag.toLowerCase().includes(searchQuery.toLowerCase())
      );
    const matchesCategory =
      selectedCategory === '' || p.category === selectedCategory;
    const matchesDifficulty =
      selectedDifficulty === '' || p.difficulty === selectedDifficulty;
    const matchesCloudProvider =
      selectedCloudProvider === '' || p.cloudProvider === selectedCloudProvider;

    return (
      matchesSearch &&
      matchesCategory &&
      matchesDifficulty &&
      matchesCloudProvider
    );
  });

  const totalProblems = problems.length;
  const avgRating =
    problems.length > 0
      ? (
          problems.reduce((acc, p) => acc + p.rating, 0) / problems.length
        ).toFixed(1)
      : '0.0';

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-text-primary flex items-center gap-3">
          <span className="text-hn-accent font-mono">&gt;_</span>
          問題マーケットプレイス
        </h1>
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

            <div>
              <label
                htmlFor={cloudProviderFilterId}
                className="block text-xs font-medium text-text-muted mb-1"
              >
                クラウド
              </label>
              <Select
                id={cloudProviderFilterId}
                value={selectedCloudProvider}
                onChange={(e) => setSelectedCloudProvider(e.target.value)}
                options={[
                  { value: '', label: 'すべて' },
                  { value: 'aws', label: 'AWS' },
                  { value: 'gcp', label: 'Google Cloud' },
                  { value: 'azure', label: 'Azure' },
                  { value: 'local', label: 'LocalStack' },
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
            <div className="text-sm font-medium text-text-muted">
              公開問題数
            </div>
            <div className="text-3xl font-bold text-text-primary mt-1 font-mono">
              {totalProblems}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <div className="text-sm font-medium text-text-muted">平均評価</div>
            <div className="text-3xl font-bold text-hn-warning mt-1 font-mono flex items-center gap-2">
              <span>★</span>
              {avgRating}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <div className="text-sm font-medium text-text-muted">検索結果</div>
            <div className="text-3xl font-bold text-hn-accent mt-1 font-mono">
              {filteredProblems.length}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Problems Grid */}
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="p-6">
                <Skeleton className="h-6 w-3/4 mb-4" />
                <div className="space-y-3">
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-2/3" />
                </div>
                <div className="flex gap-2 mt-4">
                  <Skeleton className="h-6 w-16" />
                  <Skeleton className="h-6 w-16" />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : filteredProblems.length === 0 ? (
        <Card className="text-center py-12">
          <div className="text-4xl mb-4">🔍</div>
          <h2 className="text-xl font-semibold text-text-primary mb-2">
            問題が見つかりません
          </h2>
          <p className="text-text-muted">検索条件を変更してください。</p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {filteredProblems.map((problem) => (
            <Card
              key={problem.id}
              className="group hover:border-hn-accent/50 transition-all duration-[var(--animation-duration-fast)]"
            >
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <span className="text-2xl">
                      {getCategoryIcon(problem.category)}
                    </span>
                    <div>
                      <CardTitle className="text-lg group-hover:text-hn-accent transition-colors">
                        {problem.title}
                      </CardTitle>
                      <p className="text-sm text-text-muted font-mono">
                        {problem.authorName}
                      </p>
                    </div>
                  </div>
                  <Badge
                    variant={problem.type === 'gameday' ? 'primary' : 'info'}
                  >
                    {problem.type === 'gameday' ? 'GameDay' : 'JAM'}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-text-secondary mb-4 line-clamp-2">
                  {problem.description}
                </p>

                <div className="flex flex-wrap gap-2 mb-4">
                  <Badge
                    variant={getDifficultyBadgeVariant(problem.difficulty)}
                  >
                    {getDifficultyLabel(problem.difficulty)}
                  </Badge>
                  <Badge variant="default">
                    {getCategoryLabel(problem.category)}
                  </Badge>
                  <Badge variant="default" className="font-mono uppercase">
                    {problem.cloudProvider}
                  </Badge>
                </div>

                <div className="flex items-center justify-between text-sm text-text-muted mb-4">
                  <span className="flex items-center gap-1">
                    <svg
                      className="w-4 h-4"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                      />
                    </svg>
                    {problem.estimatedTimeMinutes} 分
                  </span>
                  <span className="flex items-center gap-1 text-hn-warning">
                    ★ {problem.rating.toFixed(1)}
                  </span>
                  <span className="font-mono">{problem.usageCount} 回使用</span>
                </div>

                <div className="flex flex-wrap gap-1 mb-4">
                  {problem.tags.slice(0, 3).map((tag) => (
                    <span
                      key={tag}
                      className="text-xs px-2 py-1 bg-surface-2 text-text-muted rounded-[var(--radius)] font-mono"
                    >
                      {tag}
                    </span>
                  ))}
                  {problem.tags.length > 3 && (
                    <span className="text-xs px-2 py-1 text-text-muted">
                      +{problem.tags.length - 3}
                    </span>
                  )}
                </div>

                <div className="flex gap-2">
                  <Button variant="secondary" size="sm" className="flex-1">
                    プレビュー
                  </Button>
                  <Button size="sm" className="flex-1">
                    イベントに追加
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Terminal-style footer */}
      <div className="text-center text-text-muted text-xs font-mono py-4">
        <span className="text-hn-accent">$</span> marketplace --search --count=
        {filteredProblems.length}
      </div>
    </div>
  );
}
