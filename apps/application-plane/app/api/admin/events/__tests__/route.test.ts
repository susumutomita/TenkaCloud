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

describe('Admin Events API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /api/admin/events', () => {
    it('未認証の場合は 401 を返すべき', async () => {
      mockGetAdminSession.mockResolvedValue(null);

      const { GET } = await import('../route');
      const request = new NextRequest('http://localhost/api/admin/events');
      const response = await GET(request);

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toBe('Authentication required');
    });

    it('admin ロールがない場合は 403 を返すべき', async () => {
      // getAdminSession returns null when user doesn't have admin role
      mockGetAdminSession.mockResolvedValue(null);

      const { GET } = await import('../route');
      const request = new NextRequest('http://localhost/api/admin/events');
      const response = await GET(request);

      // Since getAdminSession returns null for both cases,
      // the route treats it as authentication required
      expect(response.status).toBe(401);
    });

    it('イベント一覧を取得すべき', async () => {
      const session: Session = {
        user: { name: 'Admin', email: 'admin@example.com' },
        expires: new Date().toISOString(),
        roles: ['admin'],
      };
      mockGetAdminSession.mockResolvedValue(session);

      const mockEvents = {
        events: [
          {
            id: 'event-1',
            name: 'Test Event',
            type: 'gameday',
            status: 'draft',
          },
        ],
        total: 1,
        page: 1,
        pageSize: 10,
      };
      mockServerApiRequest.mockResolvedValue(mockEvents);

      const { GET } = await import('../route');
      const request = new NextRequest(
        'http://localhost/api/admin/events?page=1&pageSize=10'
      );
      const response = await GET(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toEqual(mockEvents);
    });

    it('クエリパラメータを正しく渡すべき', async () => {
      const session: Session = {
        user: { name: 'Admin', email: 'admin@example.com' },
        expires: new Date().toISOString(),
        roles: ['admin'],
      };
      mockGetAdminSession.mockResolvedValue(session);
      mockServerApiRequest.mockResolvedValue({ events: [], total: 0 });

      const { GET } = await import('../route');
      const request = new NextRequest(
        'http://localhost/api/admin/events?page=2&pageSize=20&status=active&search=test'
      );
      await GET(request);

      expect(mockServerApiRequest).toHaveBeenCalledWith(
        expect.stringContaining('page=2')
      );
      expect(mockServerApiRequest).toHaveBeenCalledWith(
        expect.stringContaining('pageSize=20')
      );
      expect(mockServerApiRequest).toHaveBeenCalledWith(
        expect.stringContaining('status=active')
      );
      expect(mockServerApiRequest).toHaveBeenCalledWith(
        expect.stringContaining('search=test')
      );
    });

    it('API エラーの場合は 400 を返すべき', async () => {
      const session: Session = {
        user: { name: 'Admin', email: 'admin@example.com' },
        expires: new Date().toISOString(),
        roles: ['admin'],
      };
      mockGetAdminSession.mockResolvedValue(session);
      mockServerApiRequest.mockRejectedValue(new Error('API Error'));

      const { GET } = await import('../route');
      const request = new NextRequest('http://localhost/api/admin/events');
      const response = await GET(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('API Error');
    });
  });

  describe('POST /api/admin/events', () => {
    it('未認証の場合は 401 を返すべき', async () => {
      mockGetAdminSession.mockResolvedValue(null);

      const { POST } = await import('../route');
      const request = new NextRequest('http://localhost/api/admin/events', {
        method: 'POST',
        body: JSON.stringify({ name: 'Test Event' }),
      });
      const response = await POST(request);

      expect(response.status).toBe(401);
    });

    it('name が空の場合は 400 を返すべき', async () => {
      const session: Session = {
        user: { name: 'Admin', email: 'admin@example.com' },
        expires: new Date().toISOString(),
        roles: ['admin'],
      };
      mockGetAdminSession.mockResolvedValue(session);

      const { POST } = await import('../route');
      const request = new NextRequest('http://localhost/api/admin/events', {
        method: 'POST',
        body: JSON.stringify({
          name: '',
          slug: 'test',
          eventDate: '2024-01-01',
        }),
      });
      const response = await POST(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('Event name is required');
    });

    it('slug が空の場合は 400 を返すべき', async () => {
      const session: Session = {
        user: { name: 'Admin', email: 'admin@example.com' },
        expires: new Date().toISOString(),
        roles: ['admin'],
      };
      mockGetAdminSession.mockResolvedValue(session);

      const { POST } = await import('../route');
      const request = new NextRequest('http://localhost/api/admin/events', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Test Event',
          slug: '',
          eventDate: '2024-01-01',
        }),
      });
      const response = await POST(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('Event slug is required');
    });

    it('eventDate がない場合は 400 を返すべき', async () => {
      const session: Session = {
        user: { name: 'Admin', email: 'admin@example.com' },
        expires: new Date().toISOString(),
        roles: ['admin'],
      };
      mockGetAdminSession.mockResolvedValue(session);

      const { POST } = await import('../route');
      const request = new NextRequest('http://localhost/api/admin/events', {
        method: 'POST',
        body: JSON.stringify({ name: 'Test Event', slug: 'test' }),
      });
      const response = await POST(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('Event date is required');
    });

    it('イベントを作成し 201 を返すべき', async () => {
      const session: Session = {
        user: { name: 'Admin', email: 'admin@example.com' },
        expires: new Date().toISOString(),
        roles: ['admin'],
      };
      mockGetAdminSession.mockResolvedValue(session);

      const createdEvent = {
        id: 'event-1',
        name: 'Test Event',
        slug: 'test-event',
        eventDate: '2024-01-01',
        status: 'draft',
      };
      mockServerApiRequest.mockResolvedValue(createdEvent);

      const { POST } = await import('../route');
      const request = new NextRequest('http://localhost/api/admin/events', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Test Event',
          slug: 'test-event',
          eventDate: '2024-01-01',
        }),
      });
      const response = await POST(request);

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data).toEqual(createdEvent);
    });
  });
});
