/**
 * Admin Teams Page
 *
 * チーム管理
 */

'use client';

import { useEffect, useId, useState } from 'react';

interface Team {
  id: string;
  name: string;
  memberCount: number;
  maxMembers: number;
  createdAt: string;
  eventsCount: number;
  totalScore: number;
  captain: {
    id: string;
    name: string;
  };
}

export default function AdminTeamsPage() {
  const [teams, setTeams] = useState<Team[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputId = useId();

  useEffect(() => {
    // TODO: Replace with actual API call
    const fetchTeams = async () => {
      try {
        setLoading(true);
        // Mock data
        setTeams([
          {
            id: 'team-1',
            name: 'Cloud Warriors',
            memberCount: 4,
            maxMembers: 5,
            createdAt: new Date(Date.now() - 2592000000).toISOString(),
            eventsCount: 3,
            totalScore: 8500,
            captain: { id: 'user-1', name: '山田太郎' },
          },
          {
            id: 'team-2',
            name: 'Lambda Legends',
            memberCount: 5,
            maxMembers: 5,
            createdAt: new Date(Date.now() - 1296000000).toISOString(),
            eventsCount: 2,
            totalScore: 6200,
            captain: { id: 'user-2', name: '佐藤花子' },
          },
          {
            id: 'team-3',
            name: 'Serverless Samurai',
            memberCount: 3,
            maxMembers: 5,
            createdAt: new Date(Date.now() - 604800000).toISOString(),
            eventsCount: 1,
            totalScore: 2100,
            captain: { id: 'user-3', name: '鈴木一郎' },
          },
        ]);
      } finally {
        setLoading(false);
      }
    };

    fetchTeams();
  }, []);

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('ja-JP', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  const filteredTeams = teams.filter((t) =>
    t.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">チーム管理</h1>
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
              placeholder="チーム名で検索..."
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
          <div className="text-sm font-medium text-gray-500">総チーム数</div>
          <div className="text-3xl font-bold text-gray-900 mt-1">
            {teams.length}
          </div>
        </div>
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <div className="text-sm font-medium text-gray-500">総メンバー数</div>
          <div className="text-3xl font-bold text-gray-900 mt-1">
            {teams.reduce((acc, t) => acc + t.memberCount, 0)}
          </div>
        </div>
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <div className="text-sm font-medium text-gray-500">
            平均チームスコア
          </div>
          <div className="text-3xl font-bold text-gray-900 mt-1">
            {teams.length > 0
              ? Math.round(
                  teams.reduce((acc, t) => acc + t.totalScore, 0) / teams.length
                ).toLocaleString()
              : 0}
          </div>
        </div>
      </div>

      {/* Teams Grid */}
      {loading ? (
        <div className="flex justify-center items-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
        </div>
      ) : filteredTeams.length === 0 ? (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-12 text-center">
          <div className="text-4xl mb-4">🏆</div>
          <h2 className="text-xl font-semibold text-gray-900 mb-2">
            チームが見つかりません
          </h2>
          <p className="text-gray-500">
            {searchQuery
              ? '検索条件を変更してください。'
              : '参加者がチームを作成するとここに表示されます。'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredTeams.map((team) => (
            <div
              key={team.id}
              className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 hover:shadow-md transition-shadow"
            >
              <div className="flex items-start justify-between mb-4">
                <div>
                  <h3 className="text-lg font-semibold text-gray-900">
                    {team.name}
                  </h3>
                  <p className="text-sm text-gray-500">
                    キャプテン: {team.captain.name}
                  </p>
                </div>
                <div className="text-right">
                  <div className="text-2xl font-bold text-blue-600">
                    {team.totalScore.toLocaleString()}
                  </div>
                  <div className="text-xs text-gray-500">pts</div>
                </div>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-gray-500">メンバー</span>
                  <span className="font-medium text-gray-900">
                    {team.memberCount} / {team.maxMembers}
                  </span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-2">
                  <div
                    className="bg-blue-600 h-2 rounded-full"
                    style={{
                      width: `${(team.memberCount / team.maxMembers) * 100}%`,
                    }}
                  />
                </div>

                <div className="flex items-center justify-between text-sm">
                  <span className="text-gray-500">参加イベント</span>
                  <span className="font-medium text-gray-900">
                    {team.eventsCount}
                  </span>
                </div>

                <div className="flex items-center justify-between text-sm">
                  <span className="text-gray-500">作成日</span>
                  <span className="font-medium text-gray-900">
                    {formatDate(team.createdAt)}
                  </span>
                </div>
              </div>

              <div className="mt-4 pt-4 border-t border-gray-100">
                <button
                  type="button"
                  className="w-full text-center text-sm text-blue-600 hover:text-blue-700 font-medium"
                >
                  詳細を見る
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
