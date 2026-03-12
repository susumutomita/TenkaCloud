import { describe, expect, it, vi, beforeEach } from 'vitest';

// getSession のモック
const mockGetSession = vi.fn();
vi.mock('next-auth/react', () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
}));

describe('getAuthToken', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    mockGetSession.mockReset();
    delete process.env.NEXT_PUBLIC_AUTH_SKIP;
    vi.stubEnv('NODE_ENV', 'test');
  });

  it('AUTH_SKIP モードではモックトークンを返すべき', async () => {
    process.env.NEXT_PUBLIC_AUTH_SKIP = '1';
    const { getAuthToken } = await import('../../../lib/auth/get-auth-token');

    const token = await getAuthToken();

    expect(token).toBe('mock-access-token');
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it('通常モードでは getSession からトークンを取得すべき', async () => {
    mockGetSession.mockResolvedValue({
      accessToken: 'real-access-token',
    });
    const { getAuthToken } = await import('../../../lib/auth/get-auth-token');

    const token = await getAuthToken();

    expect(token).toBe('real-access-token');
    expect(mockGetSession).toHaveBeenCalledOnce();
  });

  it('通常モードでセッションが null の場合は null を返すべき', async () => {
    mockGetSession.mockResolvedValue(null);
    const { getAuthToken } = await import('../../../lib/auth/get-auth-token');

    const token = await getAuthToken();

    expect(token).toBeNull();
    expect(mockGetSession).toHaveBeenCalledOnce();
  });

  it('通常モードでアクセストークンが未定義の場合は null を返すべき', async () => {
    mockGetSession.mockResolvedValue({ user: { name: 'Test' } });
    const { getAuthToken } = await import('../../../lib/auth/get-auth-token');

    const token = await getAuthToken();

    expect(token).toBeNull();
    expect(mockGetSession).toHaveBeenCalledOnce();
  });

  it('本番環境では AUTH_SKIP が設定されていても getSession を使用すべき', async () => {
    process.env.NEXT_PUBLIC_AUTH_SKIP = '1';
    vi.stubEnv('NODE_ENV', 'production');
    mockGetSession.mockResolvedValue({
      accessToken: 'real-production-token',
    });
    const { getAuthToken } = await import('../../../lib/auth/get-auth-token');

    const token = await getAuthToken();

    expect(token).toBe('real-production-token');
    expect(mockGetSession).toHaveBeenCalledOnce();
  });
});
