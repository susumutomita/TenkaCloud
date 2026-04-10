import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearDevEvents,
  createDevEvent,
  findDevEvent,
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

describe('Participant Event Registration API Proxy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthSkipEnabled = false;
    clearDevEvents();
  });

  it('イベント登録を実行できるべき', async () => {
    mockServerApiRequest.mockResolvedValue({
      success: true,
      message: 'registered',
    });

    const { POST } = await import('../route');
    const response = await POST(new Request('http://localhost'), {
      params: Promise.resolve({ eventId: 'event-1' }),
    });

    expect(response.status).toBe(200);
    expect(mockServerApiRequest).toHaveBeenCalledWith(
      '/participant/events/event-1/register',
      { method: 'POST' },
    );
    await expect(response.json()).resolves.toEqual({
      success: true,
      message: 'registered',
    });
  });

  it('AUTH_SKIP 中の Unauthorized は local event を登録済みにすべき', async () => {
    mockAuthSkipEnabled = true;
    const event = createDevEvent({
      name: 'Local Event',
      status: 'active',
      type: 'gameday',
    });
    mockServerApiRequest.mockRejectedValue(new Error('Unauthorized'));

    const { POST } = await import('../route');
    const response = await POST(new Request('http://localhost'), {
      params: Promise.resolve({ eventId: event.id }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      message: 'Registered locally',
    });
    expect(findDevEvent(event.id)?.isRegistered).toBe(true);
  });

  it('network error 時も local event を登録済みにすべき', async () => {
    const event = createDevEvent({
      name: 'Offline Event',
      status: 'scheduled',
      type: 'jam',
    });
    mockServerApiRequest.mockRejectedValue(new TypeError('fetch failed'));

    const { POST } = await import('../route');
    const response = await POST(new Request('http://localhost'), {
      params: Promise.resolve({ eventId: event.id }),
    });

    expect(response.status).toBe(200);
    expect(findDevEvent(event.id)?.isRegistered).toBe(true);
  });
});
