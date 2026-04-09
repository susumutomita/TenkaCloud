import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Session } from 'next-auth';

const mockGetAdminSession = vi.fn<() => Promise<Session | null>>();
const mockServerApiRequest = vi.fn();
let mockAuthSkipEnabled = false;

vi.mock('@/auth', () => ({
  get authSkipEnabled() {
    return mockAuthSkipEnabled;
  },
}));

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

describe('Admin Analytics API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthSkipEnabled = false;
  });

  it('AUTH_SKIP 中の Unauthorized は空分析データへフォールバックするべき', async () => {
    mockAuthSkipEnabled = true;
    mockGetAdminSession.mockResolvedValue(session);
    mockServerApiRequest.mockRejectedValue(new Error('Unauthorized'));

    const { GET } = await import('../route');
    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      overview: {
        totalEvents: 0,
        totalParticipants: 0,
        avgScore: 0,
        completionRate: 0,
      },
      eventTimeline: [],
      scoreDistribution: [],
      teamComparison: [],
    });
  });

  it('analysis data を集計して返すべき', async () => {
    mockGetAdminSession.mockResolvedValue(session);
    mockServerApiRequest
      .mockResolvedValueOnce({
        events: [
          {
            id: 'evt-1',
            name: 'Event 1',
            status: 'completed',
            eventDate: '2026-01-01',
            participantCount: 10,
          },
          {
            id: 'evt-2',
            name: 'Event 2',
            status: 'active',
            eventDate: '2026-02-01',
            participantCount: 20,
          },
        ],
        total: 2,
      })
      .mockResolvedValueOnce({ total: 5 })
      .mockResolvedValueOnce({
        teams: [
          {
            id: 'team-1',
            name: 'Team A',
            memberCount: 3,
            score: 90,
            completionRate: 80,
          },
          {
            id: 'team-2',
            name: 'Team B',
            memberCount: 2,
            score: 50,
            completionRate: 40,
          },
        ],
        total: 2,
      });

    const { GET } = await import('../route');
    const response = await GET();

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.overview.totalEvents).toBe(2);
    expect(data.overview.totalParticipants).toBe(5);
    expect(data.overview.avgScore).toBe(70);
    expect(data.overview.completionRate).toBe(50);
  });
});
