/**
 * Admin Event Detail Page
 *
 * イベント詳細・編集画面
 */

'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';

interface EventDetail {
  id: string;
  name: string;
  description: string;
  status: 'draft' | 'scheduled' | 'active' | 'ended';
  type: 'gameday' | 'jam';
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

  const getStatusBadge = (status: EventDetail['status']) => {
    const styles = {
      draft: 'bg-gray-100 text-gray-800',
      scheduled: 'bg-blue-100 text-blue-800',
      active: 'bg-green-100 text-green-800',
      ended: 'bg-gray-100 text-gray-500',
    };
    const labels = {
      draft: '下書き',
      scheduled: '予定',
      active: '開催中',
      ended: '終了',
    };
    return (
      <span
        className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium ${styles[status]}`}
      >
        {labels[status]}
      </span>
    );
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    );
  }

  if (!event) {
    return (
      <div className="text-center py-12">
        <h2 className="text-xl font-semibold text-gray-900">
          イベントが見つかりません
        </h2>
        <Link
          href="/admin/events"
          className="text-blue-600 hover:text-blue-700 mt-4 inline-block"
        >
          イベント一覧に戻る
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center space-x-2 text-sm text-gray-500 mb-2">
            <Link href="/admin/events" className="hover:text-gray-700">
              イベント管理
            </Link>
            <span>/</span>
            <span>{event.name}</span>
          </div>
          <div className="flex items-center space-x-4">
            <h1 className="text-2xl font-bold text-gray-900">{event.name}</h1>
            {getStatusBadge(event.status)}
          </div>
        </div>
        <div className="flex space-x-3">
          {event.status === 'draft' && (
            <button
              type="button"
              className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700"
            >
              公開する
            </button>
          )}
          <button
            type="button"
            className="px-4 py-2 bg-white text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50"
          >
            編集
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200">
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
              className={`py-4 px-1 border-b-2 font-medium text-sm ${
                activeTab === tab.id
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
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
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
              <h2 className="text-lg font-semibold text-gray-900 mb-4">
                イベント情報
              </h2>
              <dl className="space-y-4">
                <div>
                  <dt className="text-sm font-medium text-gray-500">説明</dt>
                  <dd className="mt-1 text-sm text-gray-900">
                    {event.description}
                  </dd>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <dt className="text-sm font-medium text-gray-500">
                      開始日時
                    </dt>
                    <dd className="mt-1 text-sm text-gray-900">
                      {formatDate(event.startTime)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-gray-500">
                      終了日時
                    </dt>
                    <dd className="mt-1 text-sm text-gray-900">
                      {formatDate(event.endTime)}
                    </dd>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <dt className="text-sm font-medium text-gray-500">
                      クラウドプロバイダー
                    </dt>
                    <dd className="mt-1 text-sm text-gray-900 uppercase">
                      {event.cloudProvider}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-gray-500">
                      参加形式
                    </dt>
                    <dd className="mt-1 text-sm text-gray-900">
                      {event.participantType === 'team'
                        ? 'チーム参加'
                        : '個人参加'}
                    </dd>
                  </div>
                </div>
              </dl>
            </div>
          </div>

          <div className="space-y-6">
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
              <h2 className="text-lg font-semibold text-gray-900 mb-4">
                参加状況
              </h2>
              <div className="text-center">
                <div className="text-4xl font-bold text-gray-900">
                  {event.participantCount}
                  <span className="text-lg text-gray-500">
                    {' '}
                    / {event.maxParticipants}
                  </span>
                </div>
                <p className="text-sm text-gray-500 mt-1">参加者</p>
                <div className="mt-4 w-full bg-gray-200 rounded-full h-2">
                  <div
                    className="bg-blue-600 h-2 rounded-full"
                    style={{
                      width: `${(event.participantCount / event.maxParticipants) * 100}%`,
                    }}
                  />
                </div>
              </div>
            </div>

            <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
              <h2 className="text-lg font-semibold text-gray-900 mb-4">
                問題数
              </h2>
              <div className="text-center">
                <div className="text-4xl font-bold text-gray-900">
                  {event.problems.length}
                </div>
                <p className="text-sm text-gray-500 mt-1">問題</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'problems' && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
          <div className="p-4 border-b border-gray-200 flex justify-between items-center">
            <h2 className="text-lg font-semibold text-gray-900">問題一覧</h2>
            <button
              type="button"
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm"
            >
              問題を追加
            </button>
          </div>
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  タイトル
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  配点
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  解答数
                </th>
                <th className="px-6 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {event.problems.map((problem) => (
                <tr key={problem.id}>
                  <td className="px-6 py-4 text-sm font-medium text-gray-900">
                    {problem.title}
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-500">
                    {problem.points} pts
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-500">
                    {problem.solvedCount}
                  </td>
                  <td className="px-6 py-4 text-right text-sm">
                    <button
                      type="button"
                      className="text-blue-600 hover:text-blue-900"
                    >
                      編集
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {activeTab === 'participants' && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <div className="text-center py-12">
            <div className="text-4xl mb-4">👥</div>
            <h2 className="text-xl font-semibold text-gray-900 mb-2">
              参加者管理
            </h2>
            <p className="text-gray-500">
              {event.participantCount} 人が参加しています
            </p>
            <button
              type="button"
              className="mt-4 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
            >
              参加者一覧を見る
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
