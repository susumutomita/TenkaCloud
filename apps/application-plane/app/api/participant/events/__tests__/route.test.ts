import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockServerApiRequest = vi.fn();

vi.mock('@/lib/api/server', () => ({
  serverApiRequest: (...args: unknown[]) => mockServerApiRequest(...args),
  successResponse: <T>(data: T, status = 200) =>
    new Response(JSON.stringify(data), { status }),
  badRequestResponse: (msg = 'Bad Request') =>
    new Response(JSON.stringify({ error: msg }), { status: 400 }),
}));

describe('Participant Events API Proxy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('イベント一覧を取得できるべき', async () => {
    mockServerApiRequest.mockResolvedValue({
      events: [{ id: 'event-1', name: 'Event 1' }],
      total: 1,
    });

    const { GET } = await import('../route');
    const request = new NextRequest(
      'http://localhost/api/participant/events?status=active&limit=10',
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(mockServerApiRequest).toHaveBeenCalledWith(
      '/participant/events?status=active&limit=10',
    );
    await expect(response.json()).resolves.toEqual({
      events: [{ id: 'event-1', name: 'Event 1' }],
      total: 1,
    });
  });

  it('network fetch failure の場合は空一覧を返すべき', async () => {
    mockServerApiRequest.mockRejectedValue(new TypeError('fetch failed'));

    const { GET } = await import('../route');
    const request = new NextRequest('http://localhost/api/participant/events');
    const response = await GET(request);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ events: [], total: 0 });
  });

  it('通常の API エラーは 400 を返すべき', async () => {
    mockServerApiRequest.mockRejectedValue(new Error('Unauthorized'));

    const { GET } = await import('../route');
    const request = new NextRequest('http://localhost/api/participant/events');
    const response = await GET(request);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'Unauthorized',
    });
  });
});
