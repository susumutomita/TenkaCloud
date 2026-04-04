/**
 * Admin Analytics API
 *
 * 管理者向け分析データエンドポイント
 * - GET: 分析データ取得
 */

import {
  getAdminSession,
  unauthorizedResponse,
  forbiddenResponse,
  badRequestResponse,
  successResponse,
  serverApiRequest,
} from '@/lib/api/server';
import type { AnalyticsData } from '@/lib/api/admin-analytics';

/**
 * バックエンドイベントレスポンス型
 */
interface BackendEventsResponse {
  events: Array<{
    id: string;
    name: string;
    status: string;
    eventDate: string;
    participantCount?: number;
  }>;
  total: number;
}

/**
 * バックエンドダッシュボード統計型
 */
interface BackendDashboardStats {
  activeEvents: number;
  totalParticipants: number;
  totalTeams: number;
  upcomingEvents: number;
}

/**
 * バックエンドチームレスポンス型
 */
interface BackendTeamsResponse {
  teams: Array<{
    id: string;
    name: string;
    memberCount: number;
    score?: number;
    completionRate?: number;
  }>;
  total: number;
}

/**
 * 月ごとにイベントを集計する
 */
function aggregateEventsByMonth(
  events: BackendEventsResponse['events'],
): Array<{ month: string; eventCount: number; participantCount: number }> {
  const monthMap = new Map<
    string,
    { eventCount: number; participantCount: number }
  >();

  for (const event of events) {
    const date = new Date(event.eventDate);
    const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

    const existing = monthMap.get(monthKey) ?? {
      eventCount: 0,
      participantCount: 0,
    };
    existing.eventCount += 1;
    existing.participantCount += event.participantCount ?? 0;
    monthMap.set(monthKey, existing);
  }

  return Array.from(monthMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, data]) => ({
      month,
      eventCount: data.eventCount,
      participantCount: data.participantCount,
    }));
}

/**
 * スコア分布を計算する
 */
function calculateScoreDistribution(
  teams: BackendTeamsResponse['teams'],
): Array<{ category: string; value: number }> {
  const ranges = [
    { category: '0-20', min: 0, max: 20 },
    { category: '21-40', min: 21, max: 40 },
    { category: '41-60', min: 41, max: 60 },
    { category: '61-80', min: 61, max: 80 },
    { category: '81-100', min: 81, max: 100 },
  ];

  return ranges.map(({ category, min, max }) => ({
    category,
    value: teams.filter((t) => {
      const score = t.score ?? 0;
      return score >= min && score <= max;
    }).length,
  }));
}

/**
 * GET /api/admin/analytics
 *
 * 分析データを取得（管理者のみ）
 */
export async function GET() {
  const session = await getAdminSession();
  if (!session) {
    return session === null
      ? unauthorizedResponse('Authentication required')
      : forbiddenResponse('Admin role required');
  }

  try {
    const [eventsData, statsData, teamsData] = await Promise.all([
      serverApiRequest<BackendEventsResponse>(
        '/admin/events?page=1&pageSize=1000',
      ),
      serverApiRequest<BackendDashboardStats>('/admin/dashboard/stats'),
      serverApiRequest<BackendTeamsResponse>(
        '/admin/teams?page=1&pageSize=1000',
      ),
    ]);

    const events = eventsData.events ?? [];
    const teams = teamsData.teams ?? [];

    const totalScores = teams.reduce((sum, t) => sum + (t.score ?? 0), 0);
    const avgScore =
      teams.length > 0 ? Math.round(totalScores / teams.length) : 0;

    const completedEvents = events.filter(
      (e) => e.status === 'completed',
    ).length;
    const completionRate =
      events.length > 0
        ? Math.round((completedEvents / events.length) * 100)
        : 0;

    const analyticsData: AnalyticsData = {
      overview: {
        totalEvents: eventsData.total ?? events.length,
        totalParticipants: statsData.totalParticipants ?? 0,
        avgScore,
        completionRate,
      },
      eventTimeline: aggregateEventsByMonth(events),
      scoreDistribution: calculateScoreDistribution(teams),
      teamComparison: teams.map((t) => ({
        teamName: t.name,
        score: t.score ?? 0,
        memberCount: t.memberCount,
        completionRate: t.completionRate ?? 0,
      })),
    };

    return successResponse(analyticsData);
  } catch (error) {
    console.error('Failed to fetch analytics:', error);
    return badRequestResponse(
      error instanceof Error ? error.message : 'Failed to fetch analytics',
    );
  }
}
