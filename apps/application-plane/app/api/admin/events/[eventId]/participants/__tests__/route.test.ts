import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
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

describe('Admin Event Participants API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const createParams = (eventId: string) => Promise.resolve({ eventId });

  const adminSession: Session = {
    user: { name: 'Admin', email: 'admin@example.com' },
    expires: new Date().toISOString(),
    roles: ['admin'],
  };

  describe('GET /api/admin/events/[eventId]/participants', () => {
    it('未認証の場合は 401 を返すべき', async () => {
      mockGetAdminSession.mockResolvedValue(null);

      const { GET } = await import('../route');
      const request = new NextRequest(
        'http://localhost/api/admin/events/event-1/participants',
      );
      const response = await GET(request, {
        params: createParams('event-1'),
      });

      expect(response.status).toBe(401);
    });

    it('イベントの参加者一覧を取得すべき', async () => {
      mockGetAdminSession.mockResolvedValue(adminSession);

      const mockParticipants = {
        items: [
          { id: 'p-1', name: 'User 1', status: 'registered' },
          { id: 'p-2', name: 'User 2', status: 'checked_in' },
        ],
        total: 2,
      };
      mockServerApiRequest.mockResolvedValue(mockParticipants);

      const { GET } = await import('../route');
      const request = new NextRequest(
        'http://localhost/api/admin/events/event-1/participants',
      );
      const response = await GET(request, {
        params: createParams('event-1'),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toEqual(mockParticipants);
      expect(mockServerApiRequest).toHaveBeenCalledWith(
        '/admin/events/event-1/participants',
      );
    });

    it('クエリパラメータを転送すべき', async () => {
      mockGetAdminSession.mockResolvedValue(adminSession);
      mockServerApiRequest.mockResolvedValue({ items: [], total: 0 });

      const { GET } = await import('../route');
      const request = new NextRequest(
        'http://localhost/api/admin/events/event-1/participants?page=2&limit=10&search=test&status=registered',
      );
      const response = await GET(request, {
        params: createParams('event-1'),
      });

      expect(response.status).toBe(200);
      expect(mockServerApiRequest).toHaveBeenCalledWith(
        '/admin/events/event-1/participants?page=2&limit=10&search=test&status=registered',
      );
    });

    it('API エラーの場合は 400 を返すべき', async () => {
      mockGetAdminSession.mockResolvedValue(adminSession);
      mockServerApiRequest.mockRejectedValue(new Error('Backend error'));

      const { GET } = await import('../route');
      const request = new NextRequest(
        'http://localhost/api/admin/events/event-1/participants',
      );
      const response = await GET(request, {
        params: createParams('event-1'),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('Backend error');
    });
  });
});
