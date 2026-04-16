import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signIn } from '@/auth';
import { loginWithProvider } from '../actions';

// auth モジュールのモック
vi.mock('@/auth', () => ({
  signIn: vi.fn(),
}));

describe('loginWithProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('cognito プロバイダーで signIn を呼び出すべき', async () => {
    await loginWithProvider();

    expect(signIn).toHaveBeenCalledWith('cognito', {
      redirectTo: '/dashboard',
    });
  });

  it('signIn に正しいリダイレクト先を渡すべき', async () => {
    await loginWithProvider();

    expect(signIn).toHaveBeenCalledTimes(1);
    const callArgs = vi.mocked(signIn).mock.calls[0];
    expect(callArgs[1]).toEqual({ redirectTo: '/dashboard' });
  });
});
