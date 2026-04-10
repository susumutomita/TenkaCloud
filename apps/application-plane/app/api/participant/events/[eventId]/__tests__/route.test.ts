import { beforeEach, describe, expect, it, vi } from 'vitest';
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
}));

describe('Participant Event Detail API Proxy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthSkipEnabled = false;
    clearDevEvents();
  });

  it('イベント詳細を取得できるべき', async () => {
    mockServerApiRequest.mockResolvedValue({ id: 'event-1', name: 'Event 1' });

    const { GET } = await import('../route');
    const response = await GET(new Request('http://localhost'), {
      params: Promise.resolve({ eventId: 'event-1' }),
    });

    expect(response.status).toBe(200);
    expect(mockServerApiRequest).toHaveBeenCalledWith(
      '/participant/events/event-1',
    );
    await expect(response.json()).resolves.toEqual({
      id: 'event-1',
      name: 'Event 1',
    });
  });

  it('AUTH_SKIP 中の Unauthorized は local dev store を返すべき', async () => {
    mockAuthSkipEnabled = true;
    const event = createDevEvent({
      name: 'Local Event',
      status: 'draft',
      type: 'gameday',
    });
    mockServerApiRequest.mockRejectedValue(new Error('Unauthorized'));

    const { GET } = await import('../route');
    const response = await GET(new Request('http://localhost'), {
      params: Promise.resolve({ eventId: event.id }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        id: event.id,
        name: 'Local Event',
        problems: [],
      }),
    );
  });

  it('network error 時も local dev store を返すべき', async () => {
    const event = createDevEvent({
      name: 'Offline Event',
      status: 'draft',
      type: 'jam',
    });
    mockServerApiRequest.mockRejectedValue(new TypeError('fetch failed'));

    const { GET } = await import('../route');
    const response = await GET(new Request('http://localhost'), {
      params: Promise.resolve({ eventId: event.id }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        id: event.id,
        name: 'Offline Event',
        problems: [],
      }),
    );
  });
});
