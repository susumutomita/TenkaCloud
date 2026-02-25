/**
 * Problem Detail Page
 *
 * 問題詳細ページ - 目標、ヒント、テンプレートダウンロード
 */

'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Header } from '@/components/layout';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  DifficultyBadge,
  ProblemTypeBadge,
  ScoreProgress,
} from '@/components/ui';
import { getChallengeDetails, revealHint } from '@/lib/api/challenges';
import type { ChallengeDetails, ChallengeHint } from '@/lib/api/types';

export default function ProblemDetailPage() {
  const params = useParams();
  const router = useRouter();
  const battleId = params.id as string;
  const problemId = params.problemId as string;

  const [problem, setProblem] = useState<ChallengeDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchData() {
      try {
        setLoading(true);
        const data = await getChallengeDetails(battleId, problemId);
        if (!data) {
          router.push(`/battles/${battleId}/problems`);
          return;
        }
        setProblem(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : '読み込みに失敗しました');
      } finally {
        setLoading(false);
      }
    }

    fetchData();
  }, [battleId, problemId, router]);

  const handleRevealHint = async (hintId: string) => {
    if (!problem) return;

    try {
      const revealedHint = await revealHint(battleId, problemId, hintId);
      setProblem({
        ...problem,
        hints: problem.hints.map((h) => (h.id === hintId ? revealedHint : h)),
      });
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'ヒントの公開に失敗しました'
      );
    }
  };

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

  if (error || !problem) {
    return (
      <div className="min-h-screen bg-surface-0">
        <Header />
        <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <Card className="p-8 text-center">
            <p className="text-hn-error mb-4">
              {error || '問題が見つかりません'}
            </p>
            <Link href={`/battles/${battleId}/problems`}>
              <Button>問題一覧に戻る</Button>
            </Link>
          </Card>
        </main>
      </div>
    );
  }

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
            バトル詳細
          </Link>
          <span className="text-text-muted">/</span>
          <Link
            href={`/battles/${battleId}/problems`}
            className="text-hn-accent hover:text-hn-accent-bright transition-colors"
          >
            問題一覧
          </Link>
          <span className="text-text-muted">/</span>
          <span className="text-text-secondary">{problem.title}</span>
        </nav>

        {/* Problem Header */}
        <div className="mb-8">
          <div className="flex flex-wrap items-center gap-3 mb-4">
            <ProblemTypeBadge type={problem.type} />
            <DifficultyBadge difficulty={problem.difficulty} />
            {problem.isCompleted && <Badge variant="success">完了</Badge>}
          </div>
          <h1 className="text-3xl font-bold text-text-primary mb-2">
            {problem.title}
          </h1>
          <p className="text-text-secondary">{problem.overview}</p>
        </div>

        <div className="grid gap-8 lg:grid-cols-3">
          {/* Main Content */}
          <div className="lg:col-span-2 space-y-6">
            {/* Description */}
            <Card>
              <CardHeader>
                <h2 className="text-xl font-semibold text-text-primary">
                  問題詳細
                </h2>
              </CardHeader>
              <CardContent>
                <div className="prose prose-invert max-w-none text-text-secondary">
                  <p>{problem.description}</p>
                </div>

                {/* Objectives */}
                <div className="mt-6">
                  <h3 className="font-semibold text-text-primary mb-3">目標</h3>
                  <ul className="space-y-2">
                    {problem.objectives.map((obj, i) => (
                      <li key={i} className="flex items-start gap-2">
                        <span className="text-hn-accent mt-0.5">●</span>
                        <span className="text-text-secondary">{obj}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                {/* Instructions */}
                {problem.instructions.length > 0 && (
                  <div className="mt-6">
                    <h3 className="font-semibold text-text-primary mb-3">
                      手順
                    </h3>
                    <ol className="list-decimal list-inside space-y-2 text-text-secondary">
                      {problem.instructions.map((inst, i) => (
                        <li key={i}>{inst}</li>
                      ))}
                    </ol>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Hints */}
            {problem.hints.length > 0 && (
              <Card>
                <CardHeader>
                  <h2 className="text-xl font-semibold text-text-primary">
                    ヒント
                  </h2>
                </CardHeader>
                <CardContent className="space-y-4">
                  {problem.hints.map((hint: ChallengeHint) => (
                    <HintCard
                      key={hint.id}
                      hint={hint}
                      onReveal={() => handleRevealHint(hint.id)}
                    />
                  ))}
                </CardContent>
              </Card>
            )}

            {/* Scoring Criteria */}
            <Card>
              <CardHeader>
                <h2 className="text-xl font-semibold text-text-primary">
                  採点基準
                </h2>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {problem.scoringCriteria.map((criterion, i) => (
                    <div key={i} className="p-4 bg-surface-2 rounded-lg">
                      <div className="flex items-center justify-between mb-2">
                        <h4 className="font-medium text-text-primary">
                          {criterion.name}
                        </h4>
                        <span className="font-semibold text-hn-accent">
                          {criterion.currentPoints ?? 0} / {criterion.maxPoints}{' '}
                          pts
                        </span>
                      </div>
                      <p className="text-sm text-text-secondary">
                        {criterion.description}
                      </p>
                      {criterion.isPassed !== undefined && (
                        <div className="mt-2">
                          {criterion.isPassed ? (
                            <Badge variant="success" size="sm">
                              達成
                            </Badge>
                          ) : (
                            <Badge variant="default" size="sm">
                              未達成
                            </Badge>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* Resources */}
            {problem.resources.length > 0 && (
              <Card>
                <CardHeader>
                  <h2 className="text-xl font-semibold text-text-primary">
                    参考資料
                  </h2>
                </CardHeader>
                <CardContent>
                  <ul className="space-y-2">
                    {problem.resources.map((resource, i) => (
                      <li key={i}>
                        <a
                          href={resource.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-hn-accent hover:text-hn-accent-bright hover:underline flex items-center gap-2 transition-colors"
                        >
                          {resource.name}
                        </a>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            )}
          </div>

          {/* Sidebar */}
          <div className="space-y-6">
            {/* Score Card */}
            <Card>
              <CardContent className="space-y-4">
                <div className="text-center">
                  <div className="text-4xl font-bold text-hn-accent">
                    {problem.myScore ?? 0}
                  </div>
                  <div className="text-text-muted">
                    / {problem.maxScore} pts
                  </div>
                </div>

                <ScoreProgress
                  score={problem.myScore ?? 0}
                  maxScore={problem.maxScore}
                />
              </CardContent>
            </Card>

            {/* CloudFormation Template Download */}
            {problem.awsConsoleUrl && (
              <Card>
                <CardHeader>
                  <h2 className="font-semibold text-text-primary">
                    AWS アクセス
                  </h2>
                </CardHeader>
                <CardContent className="space-y-3">
                  {problem.awsAccountId && (
                    <div>
                      <div className="text-xs text-text-muted">
                        アカウント ID
                      </div>
                      <code className="text-sm text-text-secondary">
                        {problem.awsAccountId}
                      </code>
                    </div>
                  )}
                  <a
                    href={problem.awsConsoleUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block"
                  >
                    <Button variant="outline" fullWidth>
                      AWS コンソールを開く
                    </Button>
                  </a>
                </CardContent>
              </Card>
            )}

            {/* Estimated Time */}
            {problem.estimatedTimeMinutes && (
              <Card>
                <CardContent>
                  <div className="flex items-center justify-between">
                    <span className="text-text-secondary">推定所要時間</span>
                    <span className="font-medium text-text-primary">
                      {problem.estimatedTimeMinutes}分
                    </span>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

function HintCard({
  hint,
  onReveal,
}: {
  hint: ChallengeHint;
  onReveal: () => void;
}) {
  return (
    <div className="p-4 border border-border rounded-lg">
      {hint.isRevealed ? (
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Badge variant="info" size="sm">
              公開済み
            </Badge>
            <span className="text-sm text-hn-error">
              -{hint.costPoints} pts
            </span>
          </div>
          <p className="text-text-secondary">{hint.content}</p>
        </div>
      ) : (
        <div className="flex items-center justify-between">
          <div>
            <p className="font-medium text-text-primary">ヒントを表示</p>
            <p className="text-sm text-hn-error">
              使用すると {hint.costPoints} ポイント減点
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={onReveal}>
            公開する
          </Button>
        </div>
      )}
    </div>
  );
}
