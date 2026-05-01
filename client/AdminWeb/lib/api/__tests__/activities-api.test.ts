import { beforeEach, describe, expect, it, vi } from 'vitest';

const adminFetchMock = vi.fn();
vi.mock('../admin-api-client', () => ({
  adminFetch: adminFetchMock,
}));

describe('activities-api', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('tenant-management の /api/activities を limit 付きで呼び出すべき', async () => {
    adminFetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ data: [], pagination: {} }), {
          status: 200,
        }),
      ),
    );

    const { fetchActivities } = await import('../activities-api');
    await fetchActivities(25);

    expect(adminFetchMock).toHaveBeenCalledWith(
      'tenant-management',
      '/api/activities?limit=25',
      { cache: 'no-store' },
    );
  });

  it('limit 未指定時は 10 を使うべき', async () => {
    adminFetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ data: [], pagination: {} }), {
          status: 200,
        }),
      ),
    );

    const { fetchActivities } = await import('../activities-api');
    await fetchActivities();

    expect(adminFetchMock).toHaveBeenCalledWith(
      'tenant-management',
      '/api/activities?limit=10',
      { cache: 'no-store' },
    );
  });

  it('レスポンスが ok でない場合は例外を投げるべき', async () => {
    adminFetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }));

    const { fetchActivities } = await import('../activities-api');
    await expect(fetchActivities()).rejects.toThrow(
      /Failed to fetch activities: 500/,
    );
  });

  it('ok レスポンスを JSON でパースして返すべき', async () => {
    const payload = {
      data: [{ id: '1' }],
      pagination: { total: 1 },
    };
    adminFetchMock.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify(payload), { status: 200 })),
    );

    const { fetchActivities } = await import('../activities-api');
    const result = await fetchActivities();

    expect(result).toEqual(payload);
  });
});
