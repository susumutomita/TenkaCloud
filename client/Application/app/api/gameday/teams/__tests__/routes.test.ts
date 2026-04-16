import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuth = vi.fn();
const mockGetGamedayApiUrl = vi.fn();

vi.mock('@/auth', () => ({
  auth: () => mockAuth(),
}));

vi.mock('@/lib/api/backend-urls', () => ({
  getGamedayApiUrl: () => mockGetGamedayApiUrl(),
}));

describe('GameDay Team Route Fallbacks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('AUTH_SKIP', '1');
    vi.stubEnv('NODE_ENV', 'test');
    mockAuth.mockResolvedValue({
      user: { email: 'dev@example.com' },
      tenantId: 'dev-tenant',
      roles: ['participant'],
    });
    mockGetGamedayApiUrl.mockReturnValue('http://gameday.local');
  });

  it('solo route は network error 時に local membership を返すべき', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new TypeError('fetch failed')),
    );

    const { POST } = await import('../solo/route');
    const response = await POST(
      new Request('http://localhost', {
        method: 'POST',
        body: JSON.stringify({ eventId: 'dev-event-1' }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      membership: expect.objectContaining({
        teamId: expect.stringContaining('SOLO'),
      }),
    });
  });

  it('create route は network error 時に local team を作成すべき', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new TypeError('fetch failed')),
    );

    const { POST } = await import('../create/route');
    const response = await POST(
      new Request('http://localhost', {
        method: 'POST',
        body: JSON.stringify({
          eventId: 'dev-event-1',
          teamId: 'TEAM001',
          teamName: 'Blue Team',
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      teamId: 'TEAM001',
      teamName: 'Blue Team',
      inviteCode: 'EAM001',
    });
  });

  it('join route は local invite code で参加できるべき', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new TypeError('fetch failed')),
    );

    const { POST: createPOST } = await import('../create/route');
    const createResponse = await createPOST(
      new Request('http://localhost', {
        method: 'POST',
        body: JSON.stringify({
          eventId: 'dev-event-1',
          teamId: 'TEAM001',
          teamName: 'Blue Team',
        }),
      }),
    );
    const created = (await createResponse.json()) as { inviteCode: string };

    mockAuth.mockResolvedValueOnce({
      user: { email: 'another@example.com' },
    });

    const { POST: joinPOST } = await import('../join/route');
    const response = await joinPOST(
      new Request('http://localhost', {
        method: 'POST',
        body: JSON.stringify({
          eventId: 'dev-event-1',
          inviteCode: created.inviteCode,
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      teamId: 'TEAM001',
      teamName: 'Blue Team',
    });
  });

  it('solo route はリクエストボディが不正な場合 400 を返すべき', async () => {
    const { POST } = await import('../solo/route');
    const response = await POST(
      new Request('http://localhost', {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    );
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe('Invalid request body');
  });

  it('create route はリクエストボディが不正な場合 400 を返すべき', async () => {
    const { POST } = await import('../create/route');
    const response = await POST(
      new Request('http://localhost', {
        method: 'POST',
        body: JSON.stringify({ eventId: 'dev-event-1' }),
      }),
    );
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe('Invalid request body');
  });

  it('join route はリクエストボディが不正な場合 400 を返すべき', async () => {
    const { POST } = await import('../join/route');
    const response = await POST(
      new Request('http://localhost', {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    );
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe('Invalid request body');
  });

  it('solo route は非ネットワークエラー時に 500 を返すべき', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('backend error')),
    );
    const { POST } = await import('../solo/route');
    const response = await POST(
      new Request('http://localhost', {
        method: 'POST',
        body: JSON.stringify({ eventId: 'dev-event-3' }),
      }),
    );
    expect(response.status).toBe(500);
  });

  it('create route は非ネットワークエラー時に 500 を返すべき', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('backend error')),
    );
    const { POST } = await import('../create/route');
    const response = await POST(
      new Request('http://localhost', {
        method: 'POST',
        body: JSON.stringify({
          eventId: 'dev-event-3',
          teamId: 'TEAM002',
          teamName: 'Red Team',
        }),
      }),
    );
    expect(response.status).toBe(500);
  });

  it('join route は非ネットワークエラー時に 500 を返すべき', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('backend error')),
    );
    const { POST } = await import('../join/route');
    const response = await POST(
      new Request('http://localhost', {
        method: 'POST',
        body: JSON.stringify({ eventId: 'dev-event-3', inviteCode: 'ABC123' }),
      }),
    );
    expect(response.status).toBe(500);
  });

  it('my-membership route は local membership を返すべき', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new TypeError('fetch failed')),
    );

    const { POST } = await import('../solo/route');
    await POST(
      new Request('http://localhost', {
        method: 'POST',
        body: JSON.stringify({ eventId: 'dev-event-2' }),
      }),
    );

    const { GET } = await import('../my-membership/route');
    const response = await GET(
      new Request(
        'http://localhost/api/gameday/teams/my-membership?eventId=dev-event-2',
      ) as never,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      membership: expect.objectContaining({
        teamId: expect.stringContaining('SOLO'),
      }),
    });
  });

  it('create route は backend に userId を転送しないべき', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ teamId: 'TEAM001' }), { status: 201 }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const { POST } = await import('../create/route');
    await POST(
      new Request('http://localhost', {
        method: 'POST',
        body: JSON.stringify({
          eventId: 'dev-event-1',
          teamId: 'TEAM001',
          teamName: 'Blue Team',
        }),
      }),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'http://gameday.local/teams/create',
      expect.objectContaining({
        body: JSON.stringify({
          eventId: 'dev-event-1',
          teamId: 'TEAM001',
          teamName: 'Blue Team',
        }),
      }),
    );
  });

  it('join route は backend に userId を転送しないべき', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ teamId: 'TEAM001' }), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const { POST } = await import('../join/route');
    await POST(
      new Request('http://localhost', {
        method: 'POST',
        body: JSON.stringify({
          eventId: 'dev-event-1',
          inviteCode: 'ABC123',
        }),
      }),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'http://gameday.local/teams/join',
      expect.objectContaining({
        body: JSON.stringify({
          eventId: 'dev-event-1',
          inviteCode: 'ABC123',
        }),
      }),
    );
  });

  it('solo route は backend に userId を転送しないべき', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ mode: 'solo' }), { status: 201 }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const { POST } = await import('../solo/route');
    await POST(
      new Request('http://localhost', {
        method: 'POST',
        body: JSON.stringify({
          eventId: 'dev-event-1',
        }),
      }),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'http://gameday.local/teams/solo',
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-TenkaCloud-Dev-User-Id': 'dev@example.com',
          'X-TenkaCloud-Dev-Tenant-Id': 'dev-tenant',
          'X-TenkaCloud-Dev-Roles': 'participant',
        }),
        body: JSON.stringify({
          eventId: 'dev-event-1',
        }),
      }),
    );
  });

  it('my-membership route は backend query から userId を排除すべき', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ membership: null }), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const { GET } = await import('../my-membership/route');
    await GET(
      new Request(
        'http://localhost/api/gameday/teams/my-membership?eventId=dev-event-2',
      ) as never,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'http://gameday.local/teams/my-membership?eventId=dev-event-2',
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-TenkaCloud-Dev-User-Id': 'dev@example.com',
          'X-TenkaCloud-Dev-Tenant-Id': 'dev-tenant',
          'X-TenkaCloud-Dev-Roles': 'participant',
        }),
      }),
    );
  });
});
