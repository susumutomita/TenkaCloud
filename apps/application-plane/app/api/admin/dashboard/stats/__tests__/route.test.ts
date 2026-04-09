import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockGetAdminSession = vi.fn();
const mockServerApiRequest = vi.fn();

vi.mock('@/lib/api/server', () => ({
  getAdminSession: () => mockGetAdminSession(),
  serverApiRequest: (...args: unknown[]) => mockServerApiRequest(...args),
  unauthorizedResponse: (msg = 'Unauthorized') =>
    new Response(JSON.stringify({ error: msg }), { status: 401 }),
  forbiddenResponse: (msg = 'Forbidden') =>
    new Response(JSON.stringify({ error: msg }), { status: 403 }),
  successResponse: <T>(data: T, status = 200) =>
    new Response(JSON.stringify(data), { status }),
  badRequestResponse: (msg = 'Bad Request') =>
    new Response(JSON.stringify({ error: msg }), { status: 400 }),
}));

describe('Admin Dashboard Stats API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('admin 集計値を返すべき', async () => {
    mockGetAdminSession.mockResolvedValue({
      roles: ['admin'],
    });
    mockServerApiRequest
      .mockResolvedValueOnce({
        events: [
          { status: 'active' },
          { status: 'scheduled' },
          { status: 'draft' },
          { status: 'active' },
        ],
        total: 4,
      })
      .mockResolvedValueOnce({ total: 12 })
      .mockResolvedValueOnce({ total: 3 });

    const { GET } = await import('../route');
    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      activeEvents: 2,
      totalParticipants: 12,
      totalTeams: 3,
      upcomingEvents: 1,
    });
  });

  it('認証がない場合は 401 を返すべき', async () => {
    mockGetAdminSession.mockResolvedValue(null);

    const { GET } = await import('../route');
    const response = await GET();

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: 'Authentication required',
    });
  });

  it('upstream エラー時はゼロ値へフォールバックするべき', async () => {
    mockGetAdminSession.mockResolvedValue({
      roles: ['admin'],
    });
    mockServerApiRequest.mockRejectedValue(new TypeError('fetch failed'));

    const { GET } = await import('../route');
    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      activeEvents: 0,
      totalParticipants: 0,
      totalTeams: 0,
      upcomingEvents: 0,
    });
  });
});
