import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
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

const adminSession: Session = {
  user: { name: 'Admin', email: 'admin@example.com' },
  expires: new Date().toISOString(),
  roles: ['admin'],
};

describe('Admin Problems API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthSkipEnabled = false;
  });

  describe('GET /api/admin/problems', () => {
    it('AUTH_SKIP 中の Unauthorized は空一覧を返すべき', async () => {
      mockAuthSkipEnabled = true;
      mockGetAdminSession.mockResolvedValue(adminSession);
      mockServerApiRequest.mockRejectedValue(new Error('Unauthorized'));

      const { GET } = await import('../route');
      const request = new NextRequest(
        'http://localhost/api/admin/problems?page=1&limit=100',
      );
      const response = await GET(request);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        problems: [],
        total: 0,
      });
    });

    it('問題一覧を proxy できるべき', async () => {
      mockGetAdminSession.mockResolvedValue(adminSession);
      mockServerApiRequest.mockResolvedValue({
        problems: [
          {
            id: 'problem-1',
            title: 'Test Problem',
          },
        ],
        total: 1,
      });

      const { GET } = await import('../route');
      const request = new NextRequest(
        'http://localhost/api/admin/problems?page=2&limit=25&search=test',
      );
      const response = await GET(request);

      expect(response.status).toBe(200);
      expect(mockServerApiRequest).toHaveBeenCalledWith(
        '/admin/problems?search=test&limit=25',
      );
      await expect(response.json()).resolves.toMatchObject({
        total: 1,
      });
    });
  });

  describe('GET /api/admin/problems/[id]', () => {
    it('AUTH_SKIP 中の Unauthorized は stub 問題を返すべき', async () => {
      mockAuthSkipEnabled = true;
      mockGetAdminSession.mockResolvedValue(adminSession);
      mockServerApiRequest.mockRejectedValue(new Error('Unauthorized'));

      const { GET } = await import('../[id]/route');
      const request = new NextRequest('http://localhost/api/admin/problems/p1');
      const response = await GET(request, {
        params: Promise.resolve({ id: 'p1' }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.id).toBe('p1');
      expect(data.deployment.providers).toContain('aws');
    });

    it('問題詳細を proxy できるべき', async () => {
      mockGetAdminSession.mockResolvedValue(adminSession);
      mockServerApiRequest.mockResolvedValue({ id: 'p1', title: 'Problem' });

      const { GET } = await import('../[id]/route');
      const request = new NextRequest('http://localhost/api/admin/problems/p1');
      const response = await GET(request, {
        params: Promise.resolve({ id: 'p1' }),
      });

      expect(response.status).toBe(200);
      expect(mockServerApiRequest).toHaveBeenCalledWith('/admin/problems/p1');
    });
  });

  describe('PUT /api/admin/problems/[id]', () => {
    it('更新を proxy できるべき', async () => {
      mockGetAdminSession.mockResolvedValue(adminSession);
      mockServerApiRequest.mockResolvedValue({ id: 'p1', title: 'Updated' });

      const { PUT } = await import('../[id]/route');
      const request = new NextRequest(
        'http://localhost/api/admin/problems/p1',
        {
          method: 'PUT',
          body: JSON.stringify({ title: 'Updated' }),
        },
      );
      const response = await PUT(request, {
        params: Promise.resolve({ id: 'p1' }),
      });

      expect(response.status).toBe(200);
      expect(mockServerApiRequest).toHaveBeenCalledWith(
        '/admin/problems/p1',
        expect.objectContaining({ method: 'PUT' }),
      );
    });
  });

  describe('DELETE /api/admin/problems/[id]', () => {
    it('削除を proxy できるべき', async () => {
      mockGetAdminSession.mockResolvedValue(adminSession);
      mockServerApiRequest.mockResolvedValue({ success: true });

      const { DELETE } = await import('../[id]/route');
      const request = new NextRequest(
        'http://localhost/api/admin/problems/p1',
        {
          method: 'DELETE',
        },
      );
      const response = await DELETE(request, {
        params: Promise.resolve({ id: 'p1' }),
      });

      expect(response.status).toBe(200);
      expect(mockServerApiRequest).toHaveBeenCalledWith('/admin/problems/p1', {
        method: 'DELETE',
      });
    });
  });
});
