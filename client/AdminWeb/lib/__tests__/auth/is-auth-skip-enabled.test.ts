import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('isAuthSkipEnabled', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    delete process.env.AUTH_SKIP;
  });

  it('AUTH_SKIP=1 かつ非本番環境では true を返すべき', async () => {
    process.env.AUTH_SKIP = '1';
    vi.stubEnv('NODE_ENV', 'development');
    const { isAuthSkipEnabled } = await import(
      '../../../lib/auth/is-auth-skip-enabled'
    );
    expect(isAuthSkipEnabled()).toBe(true);
  });

  it('AUTH_SKIP が未設定の場合は false を返すべき', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const { isAuthSkipEnabled } = await import(
      '../../../lib/auth/is-auth-skip-enabled'
    );
    expect(isAuthSkipEnabled()).toBe(false);
  });

  it('AUTH_SKIP=0 の場合は false を返すべき', async () => {
    process.env.AUTH_SKIP = '0';
    vi.stubEnv('NODE_ENV', 'development');
    const { isAuthSkipEnabled } = await import(
      '../../../lib/auth/is-auth-skip-enabled'
    );
    expect(isAuthSkipEnabled()).toBe(false);
  });

  it('AUTH_SKIP=1 かつ NODE_ENV=production の場合はエラーを投げるべき', async () => {
    process.env.AUTH_SKIP = '1';
    vi.stubEnv('NODE_ENV', 'production');
    const { isAuthSkipEnabled } = await import(
      '../../../lib/auth/is-auth-skip-enabled'
    );
    expect(() => isAuthSkipEnabled()).toThrow(
      'AUTH_SKIP=1 is not allowed in production',
    );
  });

  it('AUTH_SKIP=1 かつ NODE_ENV=test の場合は true を返すべき', async () => {
    process.env.AUTH_SKIP = '1';
    vi.stubEnv('NODE_ENV', 'test');
    const { isAuthSkipEnabled } = await import(
      '../../../lib/auth/is-auth-skip-enabled'
    );
    expect(isAuthSkipEnabled()).toBe(true);
  });
});
