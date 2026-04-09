import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockGetAdminSession = vi.fn();

vi.mock('@/lib/api/server', () => ({
  getAdminSession: () => mockGetAdminSession(),
  unauthorizedResponse: (msg = 'Unauthorized') =>
    new Response(JSON.stringify({ error: msg }), { status: 401 }),
  forbiddenResponse: (msg = 'Forbidden') =>
    new Response(JSON.stringify({ error: msg }), { status: 403 }),
  successResponse: <T>(data: T, status = 200) =>
    new Response(JSON.stringify(data), { status }),
}));

describe('Admin Activities API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('admin なら空のアクティビティ一覧を返すべき', async () => {
    mockGetAdminSession.mockResolvedValue({
      roles: ['admin'],
    });

    const { GET } = await import('../route');
    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ activities: [] });
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
});
