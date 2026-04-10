import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { Session } from 'next-auth';

const mockGetAdminSession = vi.fn<() => Promise<Session | null>>();
const mockServerApiRequest = vi.fn();
const mockAuthSkipEnabled = true;

vi.mock('@/auth', () => ({
  authSkipEnabled: mockAuthSkipEnabled,
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

describe('Admin Teams API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /api/admin/teams', () => {
    it('チーム一覧を取得すべき', async () => {
      const session: Session = {
        user: { name: 'Admin', email: 'admin@example.com' },
        expires: new Date().toISOString(),
        roles: ['admin'],
      };
      mockGetAdminSession.mockResolvedValue(session);

      const mockTeams = {
        teams: [
          {
            id: 'team-1',
            name: 'Blue Team',
            totalScore: 1200,
            memberCount: 3,
            maxMembers: 5,
          },
        ],
        total: 1,
        page: 1,
        pageSize: 10,
      };
      mockServerApiRequest.mockResolvedValue(mockTeams);

      const { GET } = await import('../route');
      const request = new NextRequest('http://localhost/api/admin/teams');
      const response = await GET(request);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual(mockTeams);
    });

    it('AUTH_SKIP の Unauthorized は空一覧にフォールバックすべき', async () => {
      const session: Session = {
        user: { name: 'Admin', email: 'admin@example.com' },
        expires: new Date().toISOString(),
        roles: ['admin'],
      };
      mockGetAdminSession.mockResolvedValue(session);
      mockServerApiRequest.mockRejectedValue(new Error('Unauthorized'));

      const { GET } = await import('../route');
      const request = new NextRequest(
        'http://localhost/api/admin/teams?page=2&pageSize=25',
      );
      const response = await GET(request);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        teams: [],
        total: 0,
        page: 2,
        pageSize: 25,
      });
    });

    it('network error は空一覧にフォールバックすべき', async () => {
      const session: Session = {
        user: { name: 'Admin', email: 'admin@example.com' },
        expires: new Date().toISOString(),
        roles: ['admin'],
      };
      mockGetAdminSession.mockResolvedValue(session);
      mockServerApiRequest.mockRejectedValue(new TypeError('fetch failed'));

      const { GET } = await import('../route');
      const request = new NextRequest('http://localhost/api/admin/teams');
      const response = await GET(request);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        teams: [],
        total: 0,
        page: 1,
        pageSize: 10,
      });
    });
  });
});
