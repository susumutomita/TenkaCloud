'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ProblemForm } from '@/components/admin/problem-form';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { getProblem, updateProblem } from '@/lib/api/admin-problems';
import type { AdminProblem, CreateProblemRequest } from '@/lib/api/admin-types';

export default function AdminProblemEditPage() {
  const params = useParams();
  const router = useRouter();
  const problemId = params.id as string;
  const [problem, setProblem] = useState<AdminProblem | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const fetchProblem = async () => {
      try {
        setLoading(true);
        setFetchError(null);
        const data = await getProblem(problemId);
        setProblem(data);
      } catch (err) {
        console.error('Failed to fetch problem:', err);
        setFetchError('問題の取得に失敗しました');
      } finally {
        setLoading(false);
      }
    };
    fetchProblem();
  }, [problemId]);

  const handleSubmit = async (data: CreateProblemRequest) => {
    setSubmitting(true);
    try {
      await updateProblem(problemId, data);
      router.push('/admin/problems');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-32" />
        <Skeleton className="h-8 w-1/3" />
        <Card>
          <CardContent className="p-6 space-y-4">
            <Skeleton className="h-10 w-full" />
            <div className="grid grid-cols-3 gap-4">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6 space-y-4">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-10 w-full" />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (fetchError || !problem) {
    return (
      <div className="space-y-6">
        <Card className="border-hn-error">
          <CardContent className="p-6 text-center">
            <h2 className="text-xl font-semibold text-text-primary mb-2">
              {fetchError || '問題が見つかりません'}
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
      <div>
        <Button asChild variant="ghost" size="sm">
          <Link href={`/admin/problems/${problemId}`}>
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
            問題詳細に戻る
          </Link>
        </Button>
      </div>
      <ProblemForm
        formTitle={`問題編集: ${problem.title}`}
        submitLabel="更新"
        onSubmit={handleSubmit}
        submitting={submitting}
        initialData={{
          title: problem.title,
          type: problem.type,
          category: problem.category,
          difficulty: problem.difficulty,
          description: problem.description,
          deployment: problem.deployment,
          scoring: problem.scoring,
          metadata: problem.metadata,
        }}
      />
    </div>
  );
}
