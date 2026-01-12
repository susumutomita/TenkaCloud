/**
 * Admin Problem Detail Page
 *
 * HybridNext Design System - Terminal Command Center style
 * 問題詳細画面 - 問題の詳細表示、編集、デプロイ
 */

'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui';
import { getProblem, deleteProblem } from '@/lib/api/admin-problems';
import type { AdminProblem } from '@/lib/api/admin-types';
import type {
  CloudProvider,
  DifficultyLevel,
  ProblemCategory,
} from '@/lib/api/types';

export default function AdminProblemDetailPage() {
  const params = useParams();
  const router = useRouter();
  const problemId = params.id as string;

  const [problem, setProblem] = useState<AdminProblem | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchProblem = async () => {
      try {
        setLoading(true);
        setError(null);
        const data = await getProblem(problemId);
        setProblem(data);
      } catch (err) {
        console.error('Failed to fetch problem:', err);
        setError('問題の取得に失敗しました');
      } finally {
        setLoading(false);
      }
    };

    fetchProblem();
  }, [problemId]);

  const handleDelete = async () => {
    if (!problem) return;
    if (
      !confirm(`「${problem.title}」を削除しますか？この操作は取り消せません。`)
    ) {
      return;
    }

    try {
      await deleteProblem(problemId);
      router.push('/admin/problems');
    } catch (err) {
      console.error('Failed to delete problem:', err);
      alert('問題の削除に失敗しました');
    }
  };

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

  const getProviderLabel = (provider: CloudProvider): string => {
    switch (provider) {
      case 'aws':
        return 'AWS';
      case 'gcp':
        return 'Google Cloud';
      case 'azure':
        return 'Azure';
      case 'local':
        return 'LocalStack';
      default:
        return provider;
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Skeleton className="h-10 w-10" />
          <Skeleton className="h-8 w-1/3" />
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            <Card>
              <CardContent className="p-6 space-y-4">
                <Skeleton className="h-6 w-1/4" />
                <Skeleton className="h-24 w-full" />
              </CardContent>
            </Card>
          </div>
          <div className="space-y-6">
            <Card>
              <CardContent className="p-6 space-y-4">
                <Skeleton className="h-6 w-1/2" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    );
  }

  if (error || !problem) {
    return (
      <div className="space-y-6">
        <Card className="border-hn-error">
          <CardContent className="p-6 text-center">
            <div className="text-4xl mb-4">⚠️</div>
            <h2 className="text-xl font-semibold text-text-primary mb-2">
              {error || '問題が見つかりません'}
            </h2>
            <Button asChild variant="secondary" className="mt-4">
              <Link href="/admin/problems">問題一覧に戻る</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button asChild variant="ghost" size="sm">
            <Link href="/admin/problems">
              <svg
                className="w-5 h-5 mr-1"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M15 19l-7-7 7-7"
                />
              </svg>
              戻る
            </Link>
          </Button>
          <div className="flex items-center gap-3">
            <span className="text-3xl">
              {getCategoryIcon(problem.category)}
            </span>
            <div>
              <h1 className="text-2xl font-bold text-text-primary">
                {problem.title}
              </h1>
              <p className="text-sm text-text-muted font-mono">
                ID: {problem.id}
              </p>
            </div>
          </div>
        </div>
        <div className="flex gap-2">
          {problem.deployment.providers.includes('aws') && (
            <Button asChild>
              <Link href={`/admin/problems/${problem.id}/deploy`}>
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
                    d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
                  />
                </svg>
                AWS にデプロイ
              </Link>
            </Button>
          )}
          <Button
            variant="ghost"
            className="text-hn-error hover:text-hn-error hover:bg-hn-error/10"
            onClick={handleDelete}
          >
            削除
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Main Content */}
        <div className="lg:col-span-2 space-y-6">
          {/* Overview */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <svg
                  className="w-5 h-5 text-hn-accent"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                  />
                </svg>
                概要
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-text-secondary whitespace-pre-wrap">
                {problem.description.overview}
              </p>
            </CardContent>
          </Card>

          {/* Objectives */}
          {problem.description.objectives.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <svg
                    className="w-5 h-5 text-hn-accent"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"
                    />
                  </svg>
                  目標
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2">
                  {problem.description.objectives.map((objective, index) => (
                    <li key={index} className="flex items-start gap-2">
                      <span className="text-hn-accent font-mono text-sm">
                        {index + 1}.
                      </span>
                      <span className="text-text-secondary">{objective}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          {/* Hints */}
          {problem.description.hints.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <svg
                    className="w-5 h-5 text-hn-warning"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
                    />
                  </svg>
                  ヒント
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2">
                  {problem.description.hints.map((hint, index) => (
                    <li
                      key={index}
                      className="flex items-start gap-2 text-text-muted"
                    >
                      <span className="text-hn-warning">💡</span>
                      <span>{hint}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          {/* Scoring Criteria */}
          {problem.scoring.criteria.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <svg
                    className="w-5 h-5 text-hn-accent"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
                    />
                  </svg>
                  採点基準
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {problem.scoring.criteria.map((criterion, index) => (
                    <div
                      key={index}
                      className="flex items-center justify-between p-3 bg-surface-2 rounded-[var(--radius)]"
                    >
                      <div>
                        <p className="font-medium text-text-primary">
                          {criterion.name}
                        </p>
                        {criterion.description && (
                          <p className="text-sm text-text-muted">
                            {criterion.description}
                          </p>
                        )}
                      </div>
                      <div className="text-right">
                        <p className="font-mono text-hn-accent">
                          {criterion.maxPoints} pts
                        </p>
                        <p className="text-xs text-text-muted">
                          重み: {(criterion.weight * 100).toFixed(0)}%
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Sidebar */}
        <div className="space-y-6">
          {/* Quick Info */}
          <Card>
            <CardHeader>
              <CardTitle>情報</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap gap-2">
                <Badge
                  variant={problem.type === 'gameday' ? 'primary' : 'info'}
                >
                  {problem.type === 'gameday' ? 'GameDay' : 'JAM'}
                </Badge>
                <Badge variant={getDifficultyBadgeVariant(problem.difficulty)}>
                  {getDifficultyLabel(problem.difficulty)}
                </Badge>
                <Badge variant="default">
                  {getCategoryLabel(problem.category)}
                </Badge>
              </div>

              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-text-muted">作成者</span>
                  <span className="text-text-primary font-mono">
                    {problem.metadata.author}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-muted">バージョン</span>
                  <span className="text-text-primary font-mono">
                    v{problem.metadata.version}
                  </span>
                </div>
                {problem.description.estimatedTime && (
                  <div className="flex justify-between">
                    <span className="text-text-muted">推定時間</span>
                    <span className="text-text-primary font-mono">
                      {problem.description.estimatedTime}分
                    </span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-text-muted">採点タイプ</span>
                  <span className="text-text-primary font-mono uppercase">
                    {problem.scoring.type}
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Deployment */}
          <Card>
            <CardHeader>
              <CardTitle>デプロイメント</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <p className="text-sm text-text-muted mb-2">対応プロバイダー</p>
                <div className="flex flex-wrap gap-2">
                  {problem.deployment.providers.map((provider) => (
                    <Badge
                      key={provider}
                      variant="default"
                      className="font-mono uppercase"
                    >
                      {getProviderLabel(provider)}
                    </Badge>
                  ))}
                </div>
              </div>

              {problem.deployment.timeout && (
                <div className="flex justify-between text-sm">
                  <span className="text-text-muted">タイムアウト</span>
                  <span className="text-text-primary font-mono">
                    {problem.deployment.timeout}分
                  </span>
                </div>
              )}

              {problem.deployment.providers.includes('aws') && (
                <Button asChild className="w-full">
                  <Link href={`/admin/problems/${problem.id}/deploy`}>
                    AWS にデプロイ
                  </Link>
                </Button>
              )}
            </CardContent>
          </Card>

          {/* Tags */}
          {problem.metadata.tags.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>タグ</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-2">
                  {problem.metadata.tags.map((tag) => (
                    <span
                      key={tag}
                      className="text-xs px-2 py-1 bg-surface-2 text-text-muted rounded-[var(--radius)] font-mono"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Prerequisites */}
          {problem.description.prerequisites.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>前提知識</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-1 text-sm text-text-secondary">
                  {problem.description.prerequisites.map((prereq, index) => (
                    <li key={index} className="flex items-start gap-2">
                      <span className="text-hn-accent">•</span>
                      <span>{prereq}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* Terminal-style footer */}
      <div className="text-center text-text-muted text-xs font-mono py-4">
        <span className="text-hn-accent">$</span> problem --show --id=
        {problem.id.slice(0, 8)}...
      </div>
    </div>
  );
}
