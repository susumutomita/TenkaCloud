import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockServerApiRequest = vi.fn();
let mockAuthSkipEnabled = false;

vi.mock('@/auth', () => ({
  get authSkipEnabled() {
    return mockAuthSkipEnabled;
  },
}));

vi.mock('@/lib/api/server', () => ({
  serverApiRequest: (...args: unknown[]) => mockServerApiRequest(...args),
  successResponse: <T>(data: T, status = 200) =>
    new Response(JSON.stringify(data), { status }),
  badRequestResponse: (msg = 'Bad Request') =>
    new Response(JSON.stringify({ error: msg }), { status: 400 }),
}));

describe('Participant Rankings API Proxy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthSkipEnabled = false;
  });

  it('ランキング一覧を取得できるべき', async () => {
    mockServerApiRequest.mockResolvedValue({
      rankings: [{ rank: 1, userId: 'user-1', name: 'Taro', totalScore: 100 }],
      total: 1,
    });

    const { GET } = await import('../route');
    const request = new NextRequest(
      'http://localhost/api/participant/rankings?limit=20&offset=0',
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(mockServerApiRequest).toHaveBeenCalledWith(
      '/participant/rankings?limit=20&offset=0',
    );
    await expect(response.json()).resolves.toEqual({
      rankings: [{ rank: 1, userId: 'user-1', name: 'Taro', totalScore: 100 }],
      total: 1,
    });
  });

  it('network fetch failure の場合は空一覧を返すべき', async () => {
    mockServerApiRequest.mockRejectedValue(new TypeError('fetch failed'));

    const { GET } = await import('../route');
    const request = new NextRequest(
      'http://localhost/api/participant/rankings',
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ rankings: [], total: 0 });
  });

  it('AUTH_SKIP 中に Unauthorized の場合は空一覧を返すべき', async () => {
    mockAuthSkipEnabled = true;
    mockServerApiRequest.mockRejectedValue(new Error('Unauthorized'));

    const { GET } = await import('../route');
    const request = new NextRequest(
      'http://localhost/api/participant/rankings',
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ rankings: [], total: 0 });
  });

  it('通常の API エラーは 400 を返すべき', async () => {
    mockServerApiRequest.mockRejectedValue(new Error('Unauthorized'));

    const { GET } = await import('../route');
    const request = new NextRequest(
      'http://localhost/api/participant/rankings',
    );
    const response = await GET(request);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'Unauthorized',
    });
  });
});
