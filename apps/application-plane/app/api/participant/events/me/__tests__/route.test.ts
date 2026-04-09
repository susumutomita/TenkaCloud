import { describe, expect, it, vi, beforeEach } from 'vitest';

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

describe('Participant My Events API Proxy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthSkipEnabled = false;
  });

  it('AUTH_SKIP 中に Unauthorized の場合は空一覧を返すべき', async () => {
    mockAuthSkipEnabled = true;
    mockServerApiRequest.mockRejectedValue(new Error('Unauthorized'));

    const { GET } = await import('../route');
    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ events: [] });
  });

  it('参加中のイベント一覧を取得できるべき', async () => {
    mockServerApiRequest.mockResolvedValue({
      events: [{ id: 'event-1', name: 'Event 1' }],
    });

    const { GET } = await import('../route');
    const response = await GET();

    expect(response.status).toBe(200);
    expect(mockServerApiRequest).toHaveBeenCalledWith('/participant/events/me');
    await expect(response.json()).resolves.toEqual({
      events: [{ id: 'event-1', name: 'Event 1' }],
    });
  });

  it('network fetch failure の場合は空一覧を返すべき', async () => {
    mockServerApiRequest.mockRejectedValue(new TypeError('fetch failed'));

    const { GET } = await import('../route');
    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ events: [] });
  });

  it('通常の API エラーは 400 を返すべき', async () => {
    mockServerApiRequest.mockRejectedValue(new Error('Unauthorized'));

    const { GET } = await import('../route');
    const response = await GET();

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'Unauthorized',
    });
  });
});
