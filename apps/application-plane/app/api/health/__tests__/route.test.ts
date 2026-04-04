import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock backend-urls
vi.mock('@/lib/api/backend-urls', () => ({
  getAllServiceUrls: () => ({
    'problem-service': 'http://localhost:3100/api',
    'gameday-service': 'http://localhost:3020/api/gameday',
    'tenant-management': 'http://localhost:3200/api/tenant',
  }),
}));

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('Health Check API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('全サービスが正常な場合は healthy ステータスを返すべき', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    const { GET } = await import('../route');
    const response = await GET();
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.status).toBe('healthy');
    expect(data.services).toHaveLength(3);
    expect(
      data.services.every((s: { status: string }) => s.status === 'healthy')
    ).toBe(true);
  });

  it('一部サービスがダウンしている場合は degraded ステータスを返すべき', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockRejectedValueOnce(new Error('Connection refused'))
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const { GET } = await import('../route');
    const response = await GET();
    const data = await response.json();

    expect(response.status).toBe(503);
    expect(data.status).toBe('degraded');

    const gamedayService = data.services.find(
      (s: { name: string }) => s.name === 'gameday-service'
    );
    expect(gamedayService.status).toBe('unhealthy');
    expect(gamedayService.error).toBe('Connection refused');
  });

  it('全サービスがダウンしている場合は unhealthy ステータスを返すべき', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));

    const { GET } = await import('../route');
    const response = await GET();
    const data = await response.json();

    expect(response.status).toBe(503);
    expect(data.status).toBe('unhealthy');
    expect(
      data.services.every((s: { status: string }) => s.status === 'unhealthy')
    ).toBe(true);
  });

  it('HTTP エラーステータスの場合は unhealthy として扱うべき', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const { GET } = await import('../route');
    const response = await GET();
    const data = await response.json();

    expect(data.status).toBe('degraded');
    const gamedayService = data.services.find(
      (s: { name: string }) => s.name === 'gameday-service'
    );
    expect(gamedayService.status).toBe('unhealthy');
    expect(gamedayService.error).toBe('HTTP 500');
  });

  it('レスポンスにタイムスタンプを含むべき', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    const { GET } = await import('../route');
    const response = await GET();
    const data = await response.json();

    expect(data.timestamp).toBeDefined();
    expect(typeof data.timestamp).toBe('string');
  });
});
