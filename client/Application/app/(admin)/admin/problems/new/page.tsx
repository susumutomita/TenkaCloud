'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ProblemForm } from '@/components/admin/problem-form';
import { Button } from '@/components/ui/button';
import { createProblem } from '@/lib/api/admin-problems';
import type { CreateProblemRequest } from '@/lib/api/admin-types';

export default function AdminProblemCreatePage() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (data: CreateProblemRequest) => {
    setSubmitting(true);
    try {
      await createProblem(data);
      router.push('/admin/problems');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
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
            問題一覧に戻る
          </Link>
        </Button>
      </div>
      <ProblemForm
        formTitle="新規問題作成"
        submitLabel="作成"
        onSubmit={handleSubmit}
        submitting={submitting}
      />
    </div>
  );
}
