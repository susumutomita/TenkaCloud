import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { Session } from 'next-auth';

// Mock server utilities
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

describe('Admin Event Detail API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const createParams = (eventId: string) => Promise.resolve({ eventId });

  describe('GET /api/admin/events/[eventId]', () => {
    it('未認証の場合は 401 を返すべき', async () => {
      mockGetAdminSession.mockResolvedValue(null);

      const { GET } = await import('../route');
      const request = new NextRequest(
        'http://localhost/api/admin/events/event-1'
      );
      const response = await GET(request, { params: createParams('event-1') });

      expect(response.status).toBe(401);
    });

    it('イベント詳細を取得すべき', async () => {
      const session: Session = {
        user: { name: 'Admin', email: 'admin@example.com' },
        expires: new Date().toISOString(),
        roles: ['admin'],
      };
      mockGetAdminSession.mockResolvedValue(session);

      const mockEvent = {
        id: 'event-1',
        name: 'Test Event',
        type: 'gameday',
        status: 'draft',
        problems: [],
      };
      mockServerApiRequest.mockResolvedValue(mockEvent);

      const { GET } = await import('../route');
      const request = new NextRequest(
        'http://localhost/api/admin/events/event-1'
      );
      const response = await GET(request, { params: createParams('event-1') });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toEqual(mockEvent);
      expect(mockServerApiRequest).toHaveBeenCalledWith(
        '/admin/events/event-1'
      );
    });

    it('API エラーの場合は 400 を返すべき', async () => {
      const session: Session = {
        user: { name: 'Admin', email: 'admin@example.com' },
        expires: new Date().toISOString(),
        roles: ['admin'],
      };
      mockGetAdminSession.mockResolvedValue(session);
      mockServerApiRequest.mockRejectedValue(new Error('Event not found'));

      const { GET } = await import('../route');
      const request = new NextRequest(
        'http://localhost/api/admin/events/event-1'
      );
      const response = await GET(request, { params: createParams('event-1') });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('Event not found');
    });
  });

  describe('PUT /api/admin/events/[eventId]', () => {
    it('未認証の場合は 401 を返すべき', async () => {
      mockGetAdminSession.mockResolvedValue(null);

      const { PUT } = await import('../route');
      const request = new NextRequest(
        'http://localhost/api/admin/events/event-1',
        {
          method: 'PUT',
          body: JSON.stringify({ name: 'Updated Event' }),
        }
      );
      const response = await PUT(request, { params: createParams('event-1') });

      expect(response.status).toBe(401);
    });

    it('イベントを更新すべき', async () => {
      const session: Session = {
        user: { name: 'Admin', email: 'admin@example.com' },
        expires: new Date().toISOString(),
        roles: ['admin'],
      };
      mockGetAdminSession.mockResolvedValue(session);

      const updatedEvent = {
        id: 'event-1',
        name: 'Updated Event',
        type: 'gameday',
        status: 'active',
      };
      mockServerApiRequest.mockResolvedValue(updatedEvent);

      const { PUT } = await import('../route');
      const request = new NextRequest(
        'http://localhost/api/admin/events/event-1',
        {
          method: 'PUT',
          body: JSON.stringify({ name: 'Updated Event', status: 'active' }),
        }
      );
      const response = await PUT(request, { params: createParams('event-1') });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toEqual(updatedEvent);
      expect(mockServerApiRequest).toHaveBeenCalledWith(
        '/admin/events/event-1',
        expect.objectContaining({
          method: 'PUT',
        })
      );
    });
  });

  describe('DELETE /api/admin/events/[eventId]', () => {
    it('未認証の場合は 401 を返すべき', async () => {
      mockGetAdminSession.mockResolvedValue(null);

      const { DELETE } = await import('../route');
      const request = new NextRequest(
        'http://localhost/api/admin/events/event-1',
        { method: 'DELETE' }
      );
      const response = await DELETE(request, {
        params: createParams('event-1'),
      });

      expect(response.status).toBe(401);
    });

    it('イベントを削除すべき', async () => {
      const session: Session = {
        user: { name: 'Admin', email: 'admin@example.com' },
        expires: new Date().toISOString(),
        roles: ['admin'],
      };
      mockGetAdminSession.mockResolvedValue(session);
      mockServerApiRequest.mockResolvedValue(undefined);

      const { DELETE } = await import('../route');
      const request = new NextRequest(
        'http://localhost/api/admin/events/event-1',
        { method: 'DELETE' }
      );
      const response = await DELETE(request, {
        params: createParams('event-1'),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.message).toBe('Event deleted');
    });
  });
});
