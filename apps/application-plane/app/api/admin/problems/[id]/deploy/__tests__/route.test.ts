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

const adminSession: Session = {
  user: { name: 'Admin', email: 'admin@example.com' },
  expires: new Date().toISOString(),
  roles: ['admin'],
};

const routeContext = {
  params: Promise.resolve({ id: 'problem-1' }),
};

describe('Admin Problem Deploy API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /api/admin/problems/[id]/deploy', () => {
    it('未認証の場合は 401 を返すべき', async () => {
      mockGetAdminSession.mockResolvedValue(null);

      const { POST } = await import('../route');
      const request = new NextRequest(
        'http://localhost/api/admin/problems/problem-1/deploy',
        {
          method: 'POST',
          body: JSON.stringify({ region: 'ap-northeast-1' }),
        }
      );
      const response = await POST(request, routeContext);

      expect(response.status).toBe(401);
    });

    it('リージョンが空の場合は 400 を返すべき', async () => {
      mockGetAdminSession.mockResolvedValue(adminSession);

      const { POST } = await import('../route');
      const request = new NextRequest(
        'http://localhost/api/admin/problems/problem-1/deploy',
        {
          method: 'POST',
          body: JSON.stringify({ region: '' }),
        }
      );
      const response = await POST(request, routeContext);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('Region is required');
    });

    it('スタックを作成し 201 を返すべき', async () => {
      mockGetAdminSession.mockResolvedValue(adminSession);
      const deployResult = {
        message: 'Deploy started',
        stackName: 'test-stack',
        stackId: 'arn:aws:cloudformation:...',
      };
      mockServerApiRequest.mockResolvedValue(deployResult);

      const { POST } = await import('../route');
      const request = new NextRequest(
        'http://localhost/api/admin/problems/problem-1/deploy',
        {
          method: 'POST',
          body: JSON.stringify({ region: 'ap-northeast-1' }),
        }
      );
      const response = await POST(request, routeContext);

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data).toEqual(deployResult);
      expect(mockServerApiRequest).toHaveBeenCalledWith(
        '/admin/problems/problem-1/deploy',
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('バックエンドエラー時は 400 を返すべき', async () => {
      mockGetAdminSession.mockResolvedValue(adminSession);
      mockServerApiRequest.mockRejectedValue(new Error('Deploy failed'));

      const { POST } = await import('../route');
      const request = new NextRequest(
        'http://localhost/api/admin/problems/problem-1/deploy',
        {
          method: 'POST',
          body: JSON.stringify({ region: 'ap-northeast-1' }),
        }
      );
      const response = await POST(request, routeContext);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('Deploy failed');
    });

    it('Error 以外の例外でデフォルトメッセージを返すべき', async () => {
      mockGetAdminSession.mockResolvedValue(adminSession);
      mockServerApiRequest.mockRejectedValue('string error');

      const { POST } = await import('../route');
      const request = new NextRequest(
        'http://localhost/api/admin/problems/problem-1/deploy',
        {
          method: 'POST',
          body: JSON.stringify({ region: 'us-east-1' }),
        }
      );
      const response = await POST(request, routeContext);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('Failed to deploy');
    });
  });

  describe('GET /api/admin/problems/[id]/deploy', () => {
    it('未認証の場合は 401 を返すべき', async () => {
      mockGetAdminSession.mockResolvedValue(null);

      const { GET } = await import('../route');
      const request = new NextRequest(
        'http://localhost/api/admin/problems/problem-1/deploy'
      );
      const response = await GET(request, routeContext);

      expect(response.status).toBe(401);
    });

    it('ステータスを取得し 200 を返すべき', async () => {
      mockGetAdminSession.mockResolvedValue(adminSession);
      const statusData = {
        stackName: 'test-stack',
        status: 'CREATE_COMPLETE',
        outputs: { Endpoint: 'https://example.com' },
        events: [],
      };
      mockServerApiRequest.mockResolvedValue(statusData);

      const { GET } = await import('../route');
      const request = new NextRequest(
        'http://localhost/api/admin/problems/problem-1/deploy'
      );
      const response = await GET(request, routeContext);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toEqual(statusData);
    });

    it('バックエンドエラー時は 400 を返すべき', async () => {
      mockGetAdminSession.mockResolvedValue(adminSession);
      mockServerApiRequest.mockRejectedValue(new Error('Not found'));

      const { GET } = await import('../route');
      const request = new NextRequest(
        'http://localhost/api/admin/problems/problem-1/deploy'
      );
      const response = await GET(request, routeContext);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('Not found');
    });

    it('Error 以外の例外でデフォルトメッセージを返すべき', async () => {
      mockGetAdminSession.mockResolvedValue(adminSession);
      mockServerApiRequest.mockRejectedValue(42);

      const { GET } = await import('../route');
      const request = new NextRequest(
        'http://localhost/api/admin/problems/problem-1/deploy'
      );
      const response = await GET(request, routeContext);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('Failed to get status');
    });
  });

  describe('DELETE /api/admin/problems/[id]/deploy', () => {
    it('未認証の場合は 401 を返すべき', async () => {
      mockGetAdminSession.mockResolvedValue(null);

      const { DELETE } = await import('../route');
      const request = new NextRequest(
        'http://localhost/api/admin/problems/problem-1/deploy',
        { method: 'DELETE' }
      );
      const response = await DELETE(request, routeContext);

      expect(response.status).toBe(401);
    });

    it('スタックを削除し 200 を返すべき', async () => {
      mockGetAdminSession.mockResolvedValue(adminSession);
      const deleteResult = { message: 'Stack deletion initiated' };
      mockServerApiRequest.mockResolvedValue(deleteResult);

      const { DELETE } = await import('../route');
      const request = new NextRequest(
        'http://localhost/api/admin/problems/problem-1/deploy',
        { method: 'DELETE' }
      );
      const response = await DELETE(request, routeContext);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toEqual(deleteResult);
      expect(mockServerApiRequest).toHaveBeenCalledWith(
        '/admin/problems/problem-1/deploy',
        expect.objectContaining({ method: 'DELETE' })
      );
    });

    it('バックエンドエラー時は 400 を返すべき', async () => {
      mockGetAdminSession.mockResolvedValue(adminSession);
      mockServerApiRequest.mockRejectedValue(new Error('Delete failed'));

      const { DELETE } = await import('../route');
      const request = new NextRequest(
        'http://localhost/api/admin/problems/problem-1/deploy',
        { method: 'DELETE' }
      );
      const response = await DELETE(request, routeContext);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('Delete failed');
    });

    it('Error 以外の例外でデフォルトメッセージを返すべき', async () => {
      mockGetAdminSession.mockResolvedValue(adminSession);
      mockServerApiRequest.mockRejectedValue(null);

      const { DELETE } = await import('../route');
      const request = new NextRequest(
        'http://localhost/api/admin/problems/problem-1/deploy',
        { method: 'DELETE' }
      );
      const response = await DELETE(request, routeContext);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('Failed to delete stack');
    });
  });
});
