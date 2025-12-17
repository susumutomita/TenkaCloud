import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signIn } from '@/auth';
import { loginWithAuth0 } from '../actions';

// auth モジュールのモック
vi.mock('@/auth', () => ({
  signIn: vi.fn(),
}));

describe('loginWithAuth0', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('auth0 プロバイダーで signIn を呼び出すべき', async () => {
    await loginWithAuth0();

    expect(signIn).toHaveBeenCalledWith('auth0', {
      redirectTo: '/dashboard',
    });
  });

  it('signIn に正しいリダイレクト先を渡すべき', async () => {
    await loginWithAuth0();

    expect(signIn).toHaveBeenCalledTimes(1);
    const callArgs = vi.mocked(signIn).mock.calls[0];
    expect(callArgs[1]).toEqual({ redirectTo: '/dashboard' });
  });
});
