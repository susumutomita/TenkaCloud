/**
 * Admin Event Detail Page
 *
 * HybridNext Design System - Terminal Command Center style
 * イベント詳細・編集画面
 */

'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EventStatusBadge, ProblemTypeBadge } from '@/components/ui';
import type { EventStatus } from '@/lib/api/admin-types';
import type { ProblemType } from '@/lib/api/types';

interface EventDetail {
  id: string;
  name: string;
  description: string;
  status: EventStatus;
  type: ProblemType;
  startTime: string;
  endTime: string;
  participantCount: number;
  maxParticipants: number;
  cloudProvider: 'aws' | 'gcp' | 'azure';
  participantType: 'individual' | 'team';
  problems: {
    id: string;
    title: string;
    points: number;
    solvedCount: number;
  }[];
}

export default function AdminEventDetailPage() {
  const params = useParams();
  const eventId = params.eventId as string;
  const [event, setEvent] = useState<EventDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<
    'overview' | 'problems' | 'participants'
  >('overview');

  useEffect(() => {
    // TODO: Replace with actual API call
    const fetchEvent = async () => {
      try {
        setLoading(true);
        // Mock data
        setEvent({
          id: eventId,
          name: 'AWS GameDay 2024 Winter',
          description:
            'AWS のさまざまなサービスを活用して、実践的な課題に挑戦するイベントです。',
          status: 'active',
          type: 'gameday',
          startTime: new Date().toISOString(),
          endTime: new Date(Date.now() + 86400000).toISOString(),
          participantCount: 45,
          maxParticipants: 100,
          cloudProvider: 'aws',
          participantType: 'team',
          problems: [
            {
              id: 'p1',
              title: 'VPC セットアップ',
              points: 100,
              solvedCount: 38,
            },
            {
              id: 'p2',
              title: 'Lambda 関数のデプロイ',
              points: 200,
              solvedCount: 25,
            },
            { id: 'p3', title: 'RDS の設定', points: 300, solvedCount: 12 },
          ],
        });
      } finally {
        setLoading(false);
      }
    };

    fetchEvent();
  }, [eventId]);

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('ja-JP', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="space-y-2">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-8 w-64" />
          </div>
          <Skeleton className="h-10 w-32" />
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2">
            <Card>
              <CardContent className="p-6">
                <Skeleton className="h-6 w-32 mb-4" />
                <div className="space-y-4">
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-3/4" />
                </div>
              </CardContent>
            </Card>
          </div>
          <Card>
            <CardContent className="p-6">
              <Skeleton className="h-6 w-24 mb-4" />
              <Skeleton className="h-12 w-24 mx-auto" />
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  if (!event) {
    return (
      <Card className="text-center py-12">
        <div className="text-4xl mb-4">📭</div>
        <h2 className="text-xl font-semibold text-text-primary mb-2">
          イベントが見つかりません
        </h2>
        <Button variant="secondary" asChild className="mt-4">
          <Link href="/admin/events">イベント一覧に戻る</Link>
        </Button>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center space-x-2 text-sm text-text-muted mb-2 font-mono">
            <Link
              href="/admin/events"
              className="hover:text-hn-accent transition-colors"
            >
              イベント管理
            </Link>
            <span className="text-hn-accent">/</span>
            <span className="text-text-secondary">{event.name}</span>
          </div>
          <div className="flex items-center gap-4">
            <h1 className="text-2xl font-bold text-text-primary flex items-center gap-3">
              <span className="text-hn-accent font-mono">&gt;_</span>
              {event.name}
            </h1>
            <ProblemTypeBadge type={event.type} />
            <EventStatusBadge status={event.status} />
          </div>
        </div>
        <div className="flex gap-3">
          {event.status === 'draft' && (
            <Button variant="success">公開する</Button>
          )}
          <Button variant="secondary">編集</Button>
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b border-border">
        <nav className="-mb-px flex space-x-8">
          {[
            { id: 'overview', label: '概要' },
            { id: 'problems', label: '問題' },
            { id: 'participants', label: '参加者' },
          ].map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id as typeof activeTab)}
              className={`py-4 px-1 border-b-2 font-medium text-sm transition-colors ${
                activeTab === tab.id
                  ? 'border-hn-accent text-hn-accent'
                  : 'border-transparent text-text-muted hover:text-text-primary hover:border-border'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab Content */}
      {activeTab === 'overview' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
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
                      d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                    />
                  </svg>
                  イベント情報
                </CardTitle>
              </CardHeader>
              <CardContent>
                <dl className="space-y-4">
                  <div>
                    <dt className="text-sm font-medium text-text-muted">
                      説明
                    </dt>
                    <dd className="mt-1 text-sm text-text-primary">
                      {event.description}
                    </dd>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <dt className="text-sm font-medium text-text-muted">
                        開始日時
                      </dt>
                      <dd className="mt-1 text-sm text-text-primary font-mono">
                        {formatDate(event.startTime)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-sm font-medium text-text-muted">
                        終了日時
                      </dt>
                      <dd className="mt-1 text-sm text-text-primary font-mono">
                        {formatDate(event.endTime)}
                      </dd>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <dt className="text-sm font-medium text-text-muted">
                        クラウドプロバイダー
                      </dt>
                      <dd className="mt-1 text-sm text-text-primary font-mono uppercase">
                        {event.cloudProvider}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-sm font-medium text-text-muted">
                        参加形式
                      </dt>
                      <dd className="mt-1 text-sm text-text-primary">
                        {event.participantType === 'team'
                          ? 'チーム参加'
                          : '個人参加'}
                      </dd>
                    </div>
                  </div>
                </dl>
              </CardContent>
            </Card>
          </div>

          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <svg
                    className="w-5 h-5 text-hn-success"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"
                    />
                  </svg>
                  参加状況
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-center">
                  <div className="text-4xl font-bold text-text-primary font-mono">
                    {event.participantCount}
                    <span className="text-lg text-text-muted">
                      {' '}
                      / {event.maxParticipants}
                    </span>
                  </div>
                  <p className="text-sm text-text-muted mt-1">参加者</p>
                  <div className="mt-4 w-full bg-surface-2 rounded-full h-2">
                    <div
                      className="bg-hn-accent h-2 rounded-full transition-all"
                      style={{
                        width: `${(event.participantCount / event.maxParticipants) * 100}%`,
                      }}
                    />
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <svg
                    className="w-5 h-5 text-hn-purple"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
                    />
                  </svg>
                  問題数
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-center">
                  <div className="text-4xl font-bold text-hn-purple font-mono">
                    {event.problems.length}
                  </div>
                  <p className="text-sm text-text-muted mt-1">問題</p>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      )}

      {activeTab === 'problems' && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
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
                  d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
                />
              </svg>
              問題一覧
            </CardTitle>
            <Button size="sm">
              <svg
                className="w-4 h-4 mr-1"
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
              問題を追加
            </Button>
          </CardHeader>
          <CardContent>
            {event.problems.length === 0 ? (
              <div className="text-center py-8">
                <div className="text-4xl mb-4">📝</div>
                <p className="text-text-muted">問題がまだありません</p>
                <Button className="mt-4">問題を追加</Button>
              </div>
            ) : (
              <div className="space-y-3">
                {event.problems.map((problem, index) => (
                  <div
                    key={problem.id}
                    className="flex items-center justify-between p-4 bg-surface-1 rounded-[var(--radius)] border border-border hover:border-hn-accent/50 transition-colors"
                  >
                    <div className="flex items-center gap-4">
                      <div className="w-8 h-8 bg-hn-accent/20 rounded-[var(--radius)] flex items-center justify-center text-hn-accent font-mono font-bold">
                        {index + 1}
                      </div>
                      <div>
                        <div className="font-medium text-text-primary">
                          {problem.title}
                        </div>
                        <div className="text-sm text-text-muted font-mono">
                          {problem.points} pts
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      <div className="text-right">
                        <div className="text-sm text-text-muted">解答数</div>
                        <div className="font-mono text-hn-success">
                          {problem.solvedCount}
                        </div>
                      </div>
                      <Button variant="ghost" size="sm">
                        編集
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {activeTab === 'participants' && (
        <Card className="text-center py-12">
          <div className="text-4xl mb-4">👥</div>
          <h2 className="text-xl font-semibold text-text-primary mb-2">
            参加者管理
          </h2>
          <p className="text-text-muted">
            {event.participantCount} 人が参加しています
          </p>
          <Button className="mt-4">参加者一覧を見る</Button>
        </Card>
      )}

      {/* Terminal-style footer */}
      <div className="text-center text-text-muted text-xs font-mono py-4">
        <span className="text-hn-accent">$</span> event --id={eventId}
        --status={event.status}
      </div>
    </div>
  );
}
