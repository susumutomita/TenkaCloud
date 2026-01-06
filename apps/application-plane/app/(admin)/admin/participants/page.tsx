/**
 * Admin Participants Page
 *
 * 参加者管理
 */

'use client';

import { useEffect, useId, useState } from 'react';

interface Participant {
  id: string;
  name: string;
  email: string;
  joinedAt: string;
  eventsCount: number;
  totalScore: number;
  status: 'active' | 'inactive';
}

export default function AdminParticipantsPage() {
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputId = useId();

  useEffect(() => {
    // TODO: Replace with actual API call
    const fetchParticipants = async () => {
      try {
        setLoading(true);
        // Mock data
        setParticipants([
          {
            id: 'user-1',
            name: '山田太郎',
            email: 'yamada@example.com',
            joinedAt: new Date(Date.now() - 2592000000).toISOString(),
            eventsCount: 5,
            totalScore: 2500,
            status: 'active',
          },
          {
            id: 'user-2',
            name: '佐藤花子',
            email: 'sato@example.com',
            joinedAt: new Date(Date.now() - 1296000000).toISOString(),
            eventsCount: 3,
            totalScore: 1800,
            status: 'active',
          },
          {
            id: 'user-3',
            name: '鈴木一郎',
            email: 'suzuki@example.com',
            joinedAt: new Date(Date.now() - 604800000).toISOString(),
            eventsCount: 1,
            totalScore: 400,
            status: 'inactive',
          },
        ]);
      } finally {
        setLoading(false);
      }
    };

    fetchParticipants();
  }, []);

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('ja-JP', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  const filteredParticipants = participants.filter(
    (p) =>
      p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.email.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">参加者管理</h1>
        <button
          type="button"
          className="inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
        >
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
              d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z"
            />
          </svg>
          参加者を招待
        </button>
      </div>

      {/* Search */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
        <div className="max-w-md">
          <label htmlFor={searchInputId} className="sr-only">
            検索
          </label>
          <div className="relative">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <svg
                className="h-5 w-5 text-gray-400"
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
            <input
              id={searchInputId}
              type="text"
              placeholder="名前またはメールアドレスで検索..."
              className="block w-full pl-10 pr-3 py-2 border border-gray-300 rounded-lg focus:ring-blue-500 focus:border-blue-500"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <div className="text-sm font-medium text-gray-500">総参加者数</div>
          <div className="text-3xl font-bold text-gray-900 mt-1">
            {participants.length}
          </div>
        </div>
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <div className="text-sm font-medium text-gray-500">
            アクティブユーザー
          </div>
          <div className="text-3xl font-bold text-gray-900 mt-1">
            {participants.filter((p) => p.status === 'active').length}
          </div>
        </div>
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <div className="text-sm font-medium text-gray-500">平均スコア</div>
          <div className="text-3xl font-bold text-gray-900 mt-1">
            {participants.length > 0
              ? Math.round(
                  participants.reduce((acc, p) => acc + p.totalScore, 0) /
                    participants.length
                )
              : 0}
          </div>
        </div>
      </div>

      {/* Participants Table */}
      {loading ? (
        <div className="flex justify-center items-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
        </div>
      ) : filteredParticipants.length === 0 ? (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-12 text-center">
          <div className="text-4xl mb-4">👥</div>
          <h2 className="text-xl font-semibold text-gray-900 mb-2">
            参加者が見つかりません
          </h2>
          <p className="text-gray-500">
            {searchQuery
              ? '検索条件を変更してください。'
              : '参加者を招待して始めましょう。'}
          </p>
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  参加者
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  ステータス
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  参加イベント数
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  累計スコア
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  登録日
                </th>
                <th className="px-6 py-3" />
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {filteredParticipants.map((participant) => (
                <tr key={participant.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="flex items-center">
                      <div className="w-10 h-10 bg-blue-600 rounded-full flex items-center justify-center text-white font-medium">
                        {participant.name.charAt(0)}
                      </div>
                      <div className="ml-4">
                        <div className="text-sm font-medium text-gray-900">
                          {participant.name}
                        </div>
                        <div className="text-sm text-gray-500">
                          {participant.email}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span
                      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                        participant.status === 'active'
                          ? 'bg-green-100 text-green-800'
                          : 'bg-gray-100 text-gray-800'
                      }`}
                    >
                      {participant.status === 'active'
                        ? 'アクティブ'
                        : '非アクティブ'}
                    </span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                    {participant.eventsCount}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                    {participant.totalScore.toLocaleString()} pts
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                    {formatDate(participant.joinedAt)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                    <button
                      type="button"
                      className="text-blue-600 hover:text-blue-900"
                    >
                      詳細
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
