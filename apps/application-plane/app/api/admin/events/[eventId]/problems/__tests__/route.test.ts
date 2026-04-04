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

describe('Admin Event Problems API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /api/admin/events/[eventId]/problems', () => {
    it('未認証の場合は 401 を返すべき', async () => {
      mockGetAdminSession.mockResolvedValue(null);
      const { POST } = await import('../route');
      const request = new NextRequest(
        'http://localhost/api/admin/events/event-1/problems',
        { method: 'POST', body: JSON.stringify({ problemId: 'prob-1' }) }
      );
      const response = await POST(request, {
        params: Promise.resolve({ eventId: 'event-1' }),
      });
      expect(response.status).toBe(401);
    });

    it('problemId がない場合は 400 を返すべき', async () => {
      mockGetAdminSession.mockResolvedValue({
        user: { name: 'Admin', email: 'admin@example.com' },
        expires: new Date().toISOString(),
        roles: ['admin'],
      } as Session);
      const { POST } = await import('../route');
      const request = new NextRequest(
        'http://localhost/api/admin/events/event-1/problems',
        { method: 'POST', body: JSON.stringify({}) }
      );
      const response = await POST(request, {
        params: Promise.resolve({ eventId: 'event-1' }),
      });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe('Problem ID is required');
    });

    it('問題をイベントに追加して 201 を返すべき', async () => {
      mockGetAdminSession.mockResolvedValue({
        user: { name: 'Admin', email: 'admin@example.com' },
        expires: new Date().toISOString(),
        roles: ['admin'],
      } as Session);
      const mockResult = {
        eventId: 'event-1',
        problemId: 'prob-1',
        addedAt: '2026-04-03T00:00:00Z',
      };
      mockServerApiRequest.mockResolvedValue(mockResult);
      const { POST } = await import('../route');
      const request = new NextRequest(
        'http://localhost/api/admin/events/event-1/problems',
        { method: 'POST', body: JSON.stringify({ problemId: 'prob-1' }) }
      );
      const response = await POST(request, {
        params: Promise.resolve({ eventId: 'event-1' }),
      });
      expect(response.status).toBe(201);
      expect(await response.json()).toEqual(mockResult);
    });

    it('API エラーの場合は 400 を返すべき', async () => {
      mockGetAdminSession.mockResolvedValue({
        user: { name: 'Admin', email: 'admin@example.com' },
        expires: new Date().toISOString(),
        roles: ['admin'],
      } as Session);
      mockServerApiRequest.mockRejectedValue(new Error('Backend error'));
      const { POST } = await import('../route');
      const request = new NextRequest(
        'http://localhost/api/admin/events/event-1/problems',
        { method: 'POST', body: JSON.stringify({ problemId: 'prob-1' }) }
      );
      const response = await POST(request, {
        params: Promise.resolve({ eventId: 'event-1' }),
      });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe('Backend error');
    });

    it('Error 以外の例外の場合もエラーを返すべき', async () => {
      mockGetAdminSession.mockResolvedValue({
        user: { name: 'Admin', email: 'admin@example.com' },
        expires: new Date().toISOString(),
        roles: ['admin'],
      } as Session);
      mockServerApiRequest.mockRejectedValue('string error');
      const { POST } = await import('../route');
      const request = new NextRequest(
        'http://localhost/api/admin/events/event-1/problems',
        { method: 'POST', body: JSON.stringify({ problemId: 'prob-1' }) }
      );
      const response = await POST(request, {
        params: Promise.resolve({ eventId: 'event-1' }),
      });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe(
        'Failed to add problem to event'
      );
    });
  });
});
