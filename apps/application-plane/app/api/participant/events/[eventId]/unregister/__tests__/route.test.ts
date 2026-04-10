import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearDevEvents,
  createDevEvent,
  findDevEvent,
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
}));

describe('Participant Event Unregistration API Proxy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthSkipEnabled = false;
    clearDevEvents();
  });

  it('イベント登録解除を実行できるべき', async () => {
    mockServerApiRequest.mockResolvedValue({
      success: true,
      message: 'unregistered',
    });

    const { POST } = await import('../route');
    const response = await POST(new Request('http://localhost'), {
      params: Promise.resolve({ eventId: 'event-1' }),
    });

    expect(response.status).toBe(200);
    expect(mockServerApiRequest).toHaveBeenCalledWith(
      '/participant/events/event-1/unregister',
      { method: 'POST' },
    );
    await expect(response.json()).resolves.toEqual({
      success: true,
      message: 'unregistered',
    });
  });

  it('AUTH_SKIP 中の Unauthorized は local event を未登録に戻すべき', async () => {
    mockAuthSkipEnabled = true;
    const event = createDevEvent({
      name: 'Local Event',
      status: 'active',
      type: 'gameday',
    });
    setDevEventRegistration(event.id, true);
    mockServerApiRequest.mockRejectedValue(new Error('Unauthorized'));

    const { POST } = await import('../route');
    const response = await POST(new Request('http://localhost'), {
      params: Promise.resolve({ eventId: event.id }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      message: 'Unregistered locally',
    });
    expect(findDevEvent(event.id)?.isRegistered).toBe(false);
  });
});
