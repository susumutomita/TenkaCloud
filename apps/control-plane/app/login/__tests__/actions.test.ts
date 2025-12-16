import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signIn } from '@/auth';
import { loginWithKeycloak } from '../actions';

// auth モジュールのモック
vi.mock('@/auth', () => ({
  signIn: vi.fn(),
}));

describe('loginWithKeycloak', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keycloak プロバイダーで signIn を呼び出すべき', async () => {
    await loginWithKeycloak();

    expect(signIn).toHaveBeenCalledWith('keycloak', {
      redirectTo: '/dashboard',
    });
  });

  it('signIn に正しいリダイレクト先を渡すべき', async () => {
    await loginWithKeycloak();

    expect(signIn).toHaveBeenCalledTimes(1);
    const callArgs = vi.mocked(signIn).mock.calls[0];
    expect(callArgs[1]).toEqual({ redirectTo: '/dashboard' });
  });
});
