import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Session } from 'next-auth';

const mockGetAdminSession = vi.fn<() => Promise<Session | null>>();
const mockServerApiRequest = vi.fn();

vi.mock('@/lib/api/server', () => ({
  getAdminSession: () => mockGetAdminSession(),
  serverApiRequest: (...args: unknown[]) => mockServerApiRequest(...args),
  unauthorizedResponse: (msg = 'Unauthorized') =>
    new Response(JSON.stringify({ error: msg }), { status: 401 }),
  forbiddenResponse: (msg = 'Forbidden') =>
    new Response(JSON.stringify({ error: msg }), { status: 403 }),
  badRequestResponse: (msg = 'Bad Request') =>
    new Response(JSON.stringify({ error: msg }), { status: 400 }),
  successResponse: <T>(data: T, status = 200) =>
    new Response(JSON.stringify(data), { status }),
}));

const session: Session = {
  user: { name: 'Admin', email: 'admin@example.com' },
  expires: new Date().toISOString(),
  roles: ['admin'],
};

const eventsData = {
  events: [
    {
      id: 'evt-1',
      name: 'イベント1',
      status: 'completed',
      eventDate: '2026-01-15',
      participantCount: 30,
    },
    {
      id: 'evt-2',
      name: 'イベント2',
      status: 'active',
      eventDate: '2026-02-10',
      participantCount: 50,
    },
    {
      id: 'evt-3',
      name: 'イベント3',
      status: 'completed',
      eventDate: '2026-01-20',
      participantCount: 20,
    },
  ],
  total: 3,
};

const statsData = {
  activeEvents: 1,
  totalParticipants: 100,
  totalTeams: 5,
  upcomingEvents: 2,
};

const teamsData = {
  teams: [
    {
      id: 'team-1',
      name: 'チームA',
      memberCount: 4,
      score: 85,
      completionRate: 90,
    },
    {
      id: 'team-2',
      name: 'チームB',
      memberCount: 3,
      score: 45,
      completionRate: 60,
    },
  ],
  total: 2,
};

describe('Admin Analytics API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /api/admin/analytics', () => {
    it('未認証の場合は 401 を返すべき', async () => {
      mockGetAdminSession.mockResolvedValue(null);

      const { GET } = await import('../route');
      const response = await GET();

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toBe('Authentication required');
    });

    it('分析データを正しく集計して返すべき', async () => {
      mockGetAdminSession.mockResolvedValue(session);
      mockServerApiRequest
        .mockResolvedValueOnce(eventsData)
        .mockResolvedValueOnce(statsData)
        .mockResolvedValueOnce(teamsData);

      const { GET } = await import('../route');
      const response = await GET();

      expect(response.status).toBe(200);
      const data = await response.json();

      expect(data.overview.totalEvents).toBe(3);
      expect(data.overview.totalParticipants).toBe(100);
      expect(data.overview.avgScore).toBe(65);
      expect(data.overview.completionRate).toBe(67);
    });

    it('月別イベントタイムラインを生成すべき', async () => {
      mockGetAdminSession.mockResolvedValue(session);
      mockServerApiRequest
        .mockResolvedValueOnce(eventsData)
        .mockResolvedValueOnce(statsData)
        .mockResolvedValueOnce(teamsData);

      const { GET } = await import('../route');
      const response = await GET();
      const data = await response.json();

      expect(data.eventTimeline).toHaveLength(2);
      expect(data.eventTimeline[0].month).toBe('2026-01');
      expect(data.eventTimeline[0].eventCount).toBe(2);
      expect(data.eventTimeline[0].participantCount).toBe(50);
      expect(data.eventTimeline[1].month).toBe('2026-02');
      expect(data.eventTimeline[1].eventCount).toBe(1);
    });

    it('スコア分布を計算すべき', async () => {
      mockGetAdminSession.mockResolvedValue(session);
      mockServerApiRequest
        .mockResolvedValueOnce(eventsData)
        .mockResolvedValueOnce(statsData)
        .mockResolvedValueOnce(teamsData);

      const { GET } = await import('../route');
      const response = await GET();
      const data = await response.json();

      expect(data.scoreDistribution).toHaveLength(5);
      const range41to60 = data.scoreDistribution.find(
        (d: { category: string }) => d.category === '41-60'
      );
      expect(range41to60.value).toBe(1);
      const range81to100 = data.scoreDistribution.find(
        (d: { category: string }) => d.category === '81-100'
      );
      expect(range81to100.value).toBe(1);
    });

    it('チーム比較データを返すべき', async () => {
      mockGetAdminSession.mockResolvedValue(session);
      mockServerApiRequest
        .mockResolvedValueOnce(eventsData)
        .mockResolvedValueOnce(statsData)
        .mockResolvedValueOnce(teamsData);

      const { GET } = await import('../route');
      const response = await GET();
      const data = await response.json();

      expect(data.teamComparison).toHaveLength(2);
      expect(data.teamComparison[0].teamName).toBe('チームA');
      expect(data.teamComparison[0].score).toBe(85);
      expect(data.teamComparison[0].memberCount).toBe(4);
    });

    it('バックエンド API エラー時は 400 を返すべき', async () => {
      mockGetAdminSession.mockResolvedValue(session);
      mockServerApiRequest.mockRejectedValue(new Error('Backend error'));

      const { GET } = await import('../route');
      const response = await GET();

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('Backend error');
    });

    it('Error 以外の例外でも 400 を返すべき', async () => {
      mockGetAdminSession.mockResolvedValue(session);
      mockServerApiRequest.mockRejectedValue('string error');

      const { GET } = await import('../route');
      const response = await GET();

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('Failed to fetch analytics');
    });

    it('イベントが空の場合は完了率 0 を返すべき', async () => {
      mockGetAdminSession.mockResolvedValue(session);
      mockServerApiRequest
        .mockResolvedValueOnce({ events: [], total: 0 })
        .mockResolvedValueOnce(statsData)
        .mockResolvedValueOnce({ teams: [], total: 0 });

      const { GET } = await import('../route');
      const response = await GET();
      const data = await response.json();

      expect(data.overview.completionRate).toBe(0);
      expect(data.overview.avgScore).toBe(0);
      expect(data.eventTimeline).toHaveLength(0);
    });

    it('チームにスコアがない場合はデフォルト値を使うべき', async () => {
      mockGetAdminSession.mockResolvedValue(session);
      mockServerApiRequest
        .mockResolvedValueOnce(eventsData)
        .mockResolvedValueOnce(statsData)
        .mockResolvedValueOnce({
          teams: [{ id: 'team-1', name: 'チームX', memberCount: 3 }],
          total: 1,
        });

      const { GET } = await import('../route');
      const response = await GET();
      const data = await response.json();

      expect(data.teamComparison[0].score).toBe(0);
      expect(data.teamComparison[0].completionRate).toBe(0);
    });

    it('イベントに参加者数がない場合はデフォルト値を使うべき', async () => {
      mockGetAdminSession.mockResolvedValue(session);
      mockServerApiRequest
        .mockResolvedValueOnce({
          events: [
            {
              id: 'evt-1',
              name: 'テスト',
              status: 'active',
              eventDate: '2026-03-01',
            },
          ],
          total: 1,
        })
        .mockResolvedValueOnce(statsData)
        .mockResolvedValueOnce(teamsData);

      const { GET } = await import('../route');
      const response = await GET();
      const data = await response.json();

      expect(data.eventTimeline[0].participantCount).toBe(0);
    });
  });
});
