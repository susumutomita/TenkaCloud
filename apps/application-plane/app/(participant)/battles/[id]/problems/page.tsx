/**
 * Problem List Page
 *
 * バトル内の問題一覧ページ
 */

'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Header } from '@/components/layout';
import {
  Badge,
  Card,
  CardContent,
  CategoryBadge,
  DifficultyBadge,
  ErrorState,
  getErrorMessage,
  getErrorType,
  ScoreProgress,
} from '@/components/ui';
import { getEventDetails } from '@/lib/api/events';
import type { ChallengeProblem, EventDetails } from '@/lib/api/types';

export default function ProblemsPage() {
  const params = useParams();
  const battleId = params.id as string;

  const [battle, setBattle] = useState<EventDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    async function fetchData() {
      try {
        setLoading(true);
        const data = await getEventDetails(battleId);
        setBattle(data);
      } catch (err) {
        setError(
          err instanceof Error ? err : new Error('読み込みに失敗しました')
        );
      } finally {
        setLoading(false);
      }
    }

    fetchData();
  }, [battleId]);

  if (loading) {
    return (
      <div className="min-h-screen bg-surface-0">
        <Header />
        <div className="flex justify-center items-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-hn-accent" />
        </div>
      </div>
    );
  }

  if (error || !battle) {
    const displayError = error || new Error('not found');
    return (
      <div className="min-h-screen bg-surface-0">
        <Header />
        <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <ErrorState
            message={getErrorMessage(displayError)}
            type={getErrorType(displayError)}
            onRetry={() => window.location.reload()}
          />
        </main>
      </div>
    );
  }

  const canAccess = battle.isRegistered && battle.status === 'active';
  const totalMaxScore = battle.problems.reduce(
    (sum, p) => sum + p.maxScore * p.pointMultiplier,
    0
  );
  const totalMyScore = battle.problems.reduce(
    (sum, p) => sum + (p.myScore ?? 0),
    0
  );

  return (
    <div className="min-h-screen bg-surface-0">
      <Header />

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Breadcrumb */}
        <nav className="mb-6 flex items-center gap-2 text-sm">
          <Link
            href="/battles"
            className="text-hn-accent hover:text-hn-accent-bright transition-colors"
          >
            バトル一覧
          </Link>
          <span className="text-text-muted">/</span>
          <Link
            href={`/battles/${battleId}`}
            className="text-hn-accent hover:text-hn-accent-bright transition-colors"
          >
            {battle.name}
          </Link>
          <span className="text-text-muted">/</span>
          <span className="text-text-secondary">問題一覧</span>
        </nav>

        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold text-text-primary">
              問題一覧 ({battle.problemCount}問)
            </h1>
            <p className="text-text-secondary mt-1">{battle.name}</p>
          </div>
          {canAccess && totalMaxScore > 0 && (
            <div className="text-right">
              <div className="text-2xl font-bold text-hn-accent">
                {totalMyScore}
                <span className="text-text-muted text-base font-normal">
                  {' '}
                  / {totalMaxScore} pts
                </span>
              </div>
            </div>
          )}
        </div>

        {battle.problems.length === 0 ? (
          <Card className="text-center py-12">
            <h2 className="text-xl font-semibold text-text-primary mb-2">
              まだ問題がありません
            </h2>
            <p className="text-text-muted">
              バトル開始時に問題が公開されます。
            </p>
          </Card>
        ) : (
          <div className="space-y-4">
            {battle.problems.map((problem: ChallengeProblem) => (
              <ProblemRow
                key={problem.id}
                problem={problem}
                battleId={battleId}
                canAccess={canAccess && problem.isUnlocked}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

function ProblemRow({
  problem,
  battleId,
  canAccess,
}: {
  problem: ChallengeProblem;
  battleId: string;
  canAccess: boolean;
}) {
  const content = (
    <Card
      hoverable={canAccess}
      className={`${!canAccess ? 'opacity-75' : ''} ${
        problem.isCompleted ? 'border-hn-success/30' : ''
      }`}
    >
      <CardContent>
        <div className="flex items-center gap-6">
          {/* Order number */}
          <div className="text-2xl font-bold text-text-muted w-10 text-center shrink-0">
            {problem.order}
          </div>

          {/* Main info */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <h3 className="font-semibold text-text-primary truncate">
                {problem.title}
              </h3>
              {!problem.isUnlocked && (
                <Badge variant="default" size="sm">
                  ロック中
                </Badge>
              )}
              {problem.isCompleted && (
                <Badge variant="success" size="sm">
                  完了
                </Badge>
              )}
            </div>
            <p className="text-sm text-text-secondary line-clamp-1">
              {problem.overview}
            </p>
            <div className="flex items-center gap-2 mt-2">
              <DifficultyBadge difficulty={problem.difficulty} />
              <CategoryBadge category={problem.category} />
            </div>
          </div>

          {/* Score */}
          <div className="text-right shrink-0 w-24">
            <div className="text-lg font-bold text-hn-accent">
              {problem.maxScore * problem.pointMultiplier}
            </div>
            <div className="text-xs text-text-muted">pts</div>
            {problem.myScore !== undefined && problem.myScore > 0 && (
              <div className="mt-2">
                <ScoreProgress
                  score={problem.myScore}
                  maxScore={problem.maxScore * problem.pointMultiplier}
                  size="sm"
                  showLabel={false}
                />
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );

  if (!canAccess) {
    return content;
  }

  return (
    <Link
      href={`/battles/${battleId}/problems/${problem.id}`}
      data-testid={`problem-row-${problem.id}`}
    >
      {content}
    </Link>
  );
}
