import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import {
  clearDevEvents,
  createDevEvent,
} from '@/app/api/admin/events/dev-store';

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

describe('Participant Events API Proxy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthSkipEnabled = false;
    clearDevEvents();
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

  it('network fetch failure の場合は local dev events を返すべき', async () => {
    createDevEvent({
      name: 'Local Draft Event',
      status: 'draft',
      type: 'gameday',
    });
    mockServerApiRequest.mockRejectedValue(new TypeError('fetch failed'));

    const { GET } = await import('../route');
    const request = new NextRequest('http://localhost/api/participant/events');
    const response = await GET(request);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      events: [
        expect.objectContaining({
          name: 'Local Draft Event',
          status: 'draft',
        }),
      ],
      total: 1,
    });
  });

  it('AUTH_SKIP 中に Unauthorized の場合は local dev events を返すべき', async () => {
    mockAuthSkipEnabled = true;
    createDevEvent({
      name: 'Unauthorized Fallback Event',
      status: 'draft',
      type: 'jam',
    });
    mockServerApiRequest.mockRejectedValue(new Error('Unauthorized'));

    const { GET } = await import('../route');
    const request = new NextRequest('http://localhost/api/participant/events');
    const response = await GET(request);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      events: [
        expect.objectContaining({
          name: 'Unauthorized Fallback Event',
          status: 'draft',
        }),
      ],
      total: 1,
    });
  });

  it('fallback 時も type フィルタを適用すべき', async () => {
    createDevEvent({
      name: 'GameDay Event',
      type: 'gameday',
      status: 'draft',
    });
    createDevEvent({
      name: 'Jam Event',
      type: 'jam',
      status: 'draft',
    });
    mockServerApiRequest.mockRejectedValue(new TypeError('fetch failed'));

    const { GET } = await import('../route');
    const request = new NextRequest(
      'http://localhost/api/participant/events?type=gameday&limit=10',
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      events: [
        expect.objectContaining({
          name: 'GameDay Event',
          type: 'gameday',
        }),
      ],
      total: 1,
    });
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
