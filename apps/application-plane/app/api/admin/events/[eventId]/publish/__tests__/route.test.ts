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

describe('Admin Event Publish API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const createParams = (eventId: string) => Promise.resolve({ eventId });

  const adminSession: Session = {
    user: { name: 'Admin', email: 'admin@example.com' },
    expires: new Date().toISOString(),
    roles: ['admin'],
  };

  describe('POST /api/admin/events/[eventId]/publish', () => {
    it('未認証の場合は 401 を返すべき', async () => {
      mockGetAdminSession.mockResolvedValue(null);

      const { POST } = await import('../route');
      const request = new NextRequest(
        'http://localhost/api/admin/events/event-1/publish',
        {
          method: 'POST',
          body: JSON.stringify({ status: 'published' }),
        },
      );
      const response = await POST(request, {
        params: createParams('event-1'),
      });

      expect(response.status).toBe(401);
    });

    it('ステータスが未指定の場合は 400 を返すべき', async () => {
      mockGetAdminSession.mockResolvedValue(adminSession);

      const { POST } = await import('../route');
      const request = new NextRequest(
        'http://localhost/api/admin/events/event-1/publish',
        {
          method: 'POST',
          body: JSON.stringify({}),
        },
      );
      const response = await POST(request, {
        params: createParams('event-1'),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('Status is required');
    });

    it('無効なステータスの場合は 400 を返すべき', async () => {
      mockGetAdminSession.mockResolvedValue(adminSession);

      const { POST } = await import('../route');
      const request = new NextRequest(
        'http://localhost/api/admin/events/event-1/publish',
        {
          method: 'POST',
          body: JSON.stringify({ status: 'invalid' }),
        },
      );
      const response = await POST(request, {
        params: createParams('event-1'),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toContain('Invalid status');
    });

    it('イベントのステータスを変更すべき', async () => {
      mockGetAdminSession.mockResolvedValue(adminSession);

      const updatedEvent = {
        id: 'event-1',
        name: 'Test Event',
        type: 'gameday',
        status: 'published',
      };
      mockServerApiRequest.mockResolvedValue(updatedEvent);

      const { POST } = await import('../route');
      const request = new NextRequest(
        'http://localhost/api/admin/events/event-1/publish',
        {
          method: 'POST',
          body: JSON.stringify({ status: 'published' }),
        },
      );
      const response = await POST(request, {
        params: createParams('event-1'),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toEqual(updatedEvent);
      expect(mockServerApiRequest).toHaveBeenCalledWith(
        '/admin/events/event-1',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ status: 'published' }),
        }),
      );
    });

    it('API エラーの場合は 400 を返すべき', async () => {
      mockGetAdminSession.mockResolvedValue(adminSession);
      mockServerApiRequest.mockRejectedValue(
        new Error('Failed to update event status'),
      );

      const { POST } = await import('../route');
      const request = new NextRequest(
        'http://localhost/api/admin/events/event-1/publish',
        {
          method: 'POST',
          body: JSON.stringify({ status: 'running' }),
        },
      );
      const response = await POST(request, {
        params: createParams('event-1'),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('Failed to update event status');
    });
  });
});
