import { beforeEach, describe, expect, it, vi } from 'vitest';

const adminFetchMock = vi.fn();
vi.mock('../admin-api-client', () => ({
  adminFetch: adminFetchMock,
}));

describe('stats-api', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('tenant-management の /api/stats を呼び出すべき', async () => {
    const stats = {
      activeTenants: 3,
      totalTenants: 5,
      systemStatus: 'healthy',
      uptimePercentage: 99,
    };
    adminFetchMock.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify(stats), { status: 200 })),
    );

    const { fetchDashboardStats } = await import('../stats-api');
    const result = await fetchDashboardStats();

    expect(adminFetchMock).toHaveBeenCalledWith(
      'tenant-management',
      '/api/stats',
      { cache: 'no-store' },
    );
    expect(result).toEqual(stats);
  });

  it('レスポンスが ok でない場合は例外を投げるべき', async () => {
    adminFetchMock.mockResolvedValueOnce(new Response('boom', { status: 503 }));

    const { fetchDashboardStats } = await import('../stats-api');
    await expect(fetchDashboardStats()).rejects.toThrow(
      /Failed to fetch stats: 503/,
    );
  });
});
