import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockSignIn = vi.fn();

vi.mock('@/auth', () => ({
  signIn: mockSignIn,
}));

describe('ログインアクション', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('loginWithAuth0', () => {
    it('auth0 プロバイダで signIn を呼び出すべき', async () => {
      const { loginWithAuth0 } = await import('../actions');
      await loginWithAuth0();

      expect(mockSignIn).toHaveBeenCalledWith('auth0', {
        redirectTo: '/battles',
      });
    });
  });
});
