import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  clearDevEvents,
  createDevEvent,
  setDevEventRegistration,
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

describe('Participant My Events API Proxy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthSkipEnabled = false;
    clearDevEvents();
  });

  it('AUTH_SKIP 中に Unauthorized の場合は local registered events を返すべき', async () => {
    mockAuthSkipEnabled = true;
    const event = createDevEvent({
      name: 'Registered Event',
      status: 'active',
      type: 'gameday',
    });
    setDevEventRegistration(event.id, true);
    mockServerApiRequest.mockRejectedValue(new Error('Unauthorized'));

    const { GET } = await import('../route');
    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      events: [
        expect.objectContaining({
          id: event.id,
          name: 'Registered Event',
          isRegistered: true,
        }),
      ],
    });
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

  it('network fetch failure の場合は local registered events を返すべき', async () => {
    const event = createDevEvent({
      name: 'Offline Event',
      status: 'scheduled',
      type: 'jam',
    });
    setDevEventRegistration(event.id, true);
    mockServerApiRequest.mockRejectedValue(new TypeError('fetch failed'));

    const { GET } = await import('../route');
    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      events: [
        expect.objectContaining({
          id: event.id,
          name: 'Offline Event',
          isRegistered: true,
        }),
      ],
    });
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
