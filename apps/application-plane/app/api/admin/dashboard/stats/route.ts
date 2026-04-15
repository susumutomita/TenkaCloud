/**
 * Admin Dashboard Stats API
 *
 * 管理画面トップ用の集計値を返す。
 * backend の個別 API から集計し、取得失敗時はゼロ値へフォールバックする。
 */

import {
  forbiddenResponse,
  getAdminSession,
  serverApiRequest,
  serviceUnavailableResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/api/server';

interface AdminEventListResponse {
  events?: Array<{ status?: string }>;
  total?: number;
}

interface AdminParticipantListResponse {
  participants?: unknown[];
  total?: number;
  [key: string]: unknown;
}

interface AdminTeamListResponse {
  teams?: unknown[];
  total?: number;
  [key: string]: unknown;
}

interface DashboardStatsResponse {
  activeEvents: number;
  totalParticipants: number;
  totalTeams: number;
  upcomingEvents: number;
}

const EMPTY_STATS: DashboardStatsResponse = {
  activeEvents: 0,
  totalParticipants: 0,
  totalTeams: 0,
  upcomingEvents: 0,
};

async function fetchCount<T extends { total?: number; [key: string]: unknown }>(
  endpoint: string,
): Promise<number> {
  const data = await serverApiRequest<T>(endpoint);
  return data.total ?? 0;
}

export async function GET() {
  const session = await getAdminSession();
  if (!session) {
    return session === null
      ? unauthorizedResponse('Authentication required')
      : forbiddenResponse('Admin role required');
  }

  try {
    const [eventsData, participantsTotal, teamsTotal] = await Promise.all([
      serverApiRequest<AdminEventListResponse>(
        '/admin/events?page=1&pageSize=1000',
      ),
      fetchCount<AdminParticipantListResponse>(
        '/admin/participants?page=1&pageSize=1',
      ),
      fetchCount<AdminTeamListResponse>('/admin/teams?page=1&pageSize=1'),
    ]);

    const events = eventsData.events ?? [];
    const activeEvents = events.filter(
      (event) => event.status === 'active',
    ).length;
    const upcomingEvents = events.filter(
      (event) => event.status === 'scheduled',
    ).length;

    return successResponse({
      activeEvents,
      totalParticipants: participantsTotal,
      totalTeams: teamsTotal,
      upcomingEvents,
    });
  } catch (error) {
    console.error('Failed to fetch dashboard stats:', error);
    return serviceUnavailableResponse('Failed to fetch dashboard stats');
  }
}
