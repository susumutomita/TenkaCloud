import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Session } from 'next-auth';

// Mock auth
const mockAuth = vi.fn<() => Promise<Session | null>>();
vi.mock('@/auth', () => ({
  auth: () => mockAuth(),
}));

// Mock stsFederation
const mockGenerateParticipantConsoleUrl = vi.fn();
vi.mock('@/lib/aws', () => ({
  stsFederation: {
    generateParticipantConsoleUrl: (
      ...args: [string, string, string, string, number?]
    ) => mockGenerateParticipantConsoleUrl(...args),
  },
}));

describe('AWS Console Federation API', () => {
  const makeParams = (eventId: string) => ({
    params: Promise.resolve({ eventId }),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // 環境変数をクリア
    delete process.env.AWS_PARTICIPANT_ROLE_ARN;
  });

  it('未認証の場合は 401 を返すべき', async () => {
    mockAuth.mockResolvedValue(null);

    const { GET } = await import('../route');
    const request = new Request(
      'http://localhost/api/participant/events/evt-1/aws-console'
    );
    const response = await GET(request, await makeParams('evt-1'));

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe('Authentication required');
  });

  it('Role ARN が設定されていない場合は 404 を返すべき', async () => {
    const session: Session = {
      user: { name: 'Test User', email: 'test@example.com' },
      expires: new Date(Date.now() + 86400000).toISOString(),
      roles: ['participant'],
      tenantId: 'tenant-1',
      teamId: 'team-1',
    };
    mockAuth.mockResolvedValue(session);

    const { GET } = await import('../route');
    const request = new Request(
      'http://localhost/api/participant/events/evt-1/aws-console'
    );
    const response = await GET(request, await makeParams('evt-1'));

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toBe(
      'AWS Console access is not configured for this event'
    );
  });

  it('Federation URL を正常に返すべき', async () => {
    const session: Session = {
      user: { name: 'Test User', email: 'test@example.com' },
      expires: new Date(Date.now() + 86400000).toISOString(),
      roles: ['participant'],
      tenantId: 'tenant-1',
      teamId: 'team-1',
    };
    mockAuth.mockResolvedValue(session);
    process.env.AWS_PARTICIPANT_ROLE_ARN =
      'arn:aws:iam::123456789012:role/ParticipantRole';

    const expiresAt = new Date(Date.now() + 3600000);
    mockGenerateParticipantConsoleUrl.mockResolvedValue({
      url: 'https://signin.aws.amazon.com/federation?Action=login&SigninToken=test-token',
      expiresAt,
    });

    const { GET } = await import('../route');
    const request = new Request(
      'http://localhost/api/participant/events/evt-1/aws-console'
    );
    const response = await GET(request, await makeParams('evt-1'));

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.url).toContain('https://signin.aws.amazon.com/federation');
    expect(data.expiresAt).toBe(expiresAt.toISOString());
  });

  it('正しいパラメータで generateParticipantConsoleUrl を呼び出すべき', async () => {
    const session: Session = {
      user: { name: 'Test User', email: 'test@example.com' },
      expires: new Date(Date.now() + 86400000).toISOString(),
      roles: ['participant'],
      tenantId: 'tenant-1',
      teamId: 'team-1',
    };
    mockAuth.mockResolvedValue(session);
    process.env.AWS_PARTICIPANT_ROLE_ARN =
      'arn:aws:iam::123456789012:role/ParticipantRole';

    mockGenerateParticipantConsoleUrl.mockResolvedValue({
      url: 'https://signin.aws.amazon.com/federation?Action=login',
      expiresAt: new Date(),
    });

    const { GET } = await import('../route');
    const request = new Request(
      'http://localhost/api/participant/events/evt-1/aws-console'
    );
    await GET(request, await makeParams('evt-1'));

    expect(mockGenerateParticipantConsoleUrl).toHaveBeenCalledWith(
      'tenant-1',
      'test@example.com',
      'evt-1-team-1',
      'arn:aws:iam::123456789012:role/ParticipantRole'
    );
  });

  it('イベント固有の Role ARN を使用すべき', async () => {
    const session: Session = {
      user: { name: 'Test User', email: 'test@example.com' },
      expires: new Date(Date.now() + 86400000).toISOString(),
      roles: ['participant'],
      tenantId: 'tenant-1',
      teamId: 'team-1',
    };
    mockAuth.mockResolvedValue(session);
    process.env.AWS_ROLE_ARN_evt_special =
      'arn:aws:iam::999999999999:role/SpecialRole';

    mockGenerateParticipantConsoleUrl.mockResolvedValue({
      url: 'https://signin.aws.amazon.com/federation?Action=login',
      expiresAt: new Date(),
    });

    const { GET } = await import('../route');
    const request = new Request(
      'http://localhost/api/participant/events/evt_special/aws-console'
    );
    await GET(request, await makeParams('evt_special'));

    expect(mockGenerateParticipantConsoleUrl).toHaveBeenCalledWith(
      'tenant-1',
      'test@example.com',
      'evt_special-team-1',
      'arn:aws:iam::999999999999:role/SpecialRole'
    );

    delete process.env.AWS_ROLE_ARN_evt_special;
  });

  it('STS エラーの場合は 500 を返すべき', async () => {
    const session: Session = {
      user: { name: 'Test User', email: 'test@example.com' },
      expires: new Date(Date.now() + 86400000).toISOString(),
      roles: ['participant'],
      tenantId: 'tenant-1',
      teamId: 'team-1',
    };
    mockAuth.mockResolvedValue(session);
    process.env.AWS_PARTICIPANT_ROLE_ARN =
      'arn:aws:iam::123456789012:role/ParticipantRole';

    mockGenerateParticipantConsoleUrl.mockRejectedValue(
      new Error('STS AssumeRole failed: Access denied')
    );

    const { GET } = await import('../route');
    const request = new Request(
      'http://localhost/api/participant/events/evt-1/aws-console'
    );
    const response = await GET(request, await makeParams('evt-1'));

    expect(response.status).toBe(500);
    const data = await response.json();
    expect(data.error).toBe('STS AssumeRole failed: Access denied');
  });

  it('tenantId がない場合はデフォルト値を使用すべき', async () => {
    const session: Session = {
      user: { name: 'Test User', email: 'test@example.com' },
      expires: new Date(Date.now() + 86400000).toISOString(),
      roles: ['participant'],
    };
    mockAuth.mockResolvedValue(session);
    process.env.AWS_PARTICIPANT_ROLE_ARN =
      'arn:aws:iam::123456789012:role/ParticipantRole';

    mockGenerateParticipantConsoleUrl.mockResolvedValue({
      url: 'https://signin.aws.amazon.com/federation?Action=login',
      expiresAt: new Date(),
    });

    const { GET } = await import('../route');
    const request = new Request(
      'http://localhost/api/participant/events/evt-1/aws-console'
    );
    await GET(request, await makeParams('evt-1'));

    expect(mockGenerateParticipantConsoleUrl).toHaveBeenCalledWith(
      'default',
      'test@example.com',
      'evt-1-no-team',
      'arn:aws:iam::123456789012:role/ParticipantRole'
    );
  });
});
