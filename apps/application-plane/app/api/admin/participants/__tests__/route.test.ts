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

describe('Admin Participants API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /api/admin/participants', () => {
    it('参加者一覧を取得すべき', async () => {
      const session: Session = {
        user: { name: 'Admin', email: 'admin@example.com' },
        expires: new Date().toISOString(),
        roles: ['admin'],
      };
      mockGetAdminSession.mockResolvedValue(session);

      const mockParticipants = {
        participants: [
          {
            id: 'participant-1',
            displayName: 'Dev User',
            email: 'dev@example.com',
            status: 'active',
          },
        ],
        total: 1,
        page: 1,
        pageSize: 10,
      };
      mockServerApiRequest.mockResolvedValue(mockParticipants);

      const { GET } = await import('../route');
      const request = new NextRequest('http://localhost/api/admin/participants');
      const response = await GET(request);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual(mockParticipants);
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
        'http://localhost/api/admin/participants?page=2&pageSize=25',
      );
      const response = await GET(request);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        participants: [],
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
      const request = new NextRequest('http://localhost/api/admin/participants');
      const response = await GET(request);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        participants: [],
        total: 0,
        page: 1,
        pageSize: 10,
      });
    });
  });
});
