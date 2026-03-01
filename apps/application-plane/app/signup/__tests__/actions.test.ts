import { describe, it, expect, vi } from 'vitest';

const mockSignIn = vi.fn();
vi.mock('@/auth', () => ({
  signIn: (...args: unknown[]) => mockSignIn(...args),
}));

describe('signupWithAuth0', () => {
  it('Auth0 の signIn をサインアップヒント付きで呼び出すべき', async () => {
    const { signupWithAuth0 } = await import('../actions');
    await signupWithAuth0();

    expect(mockSignIn).toHaveBeenCalledWith('auth0', {
      redirectTo: '/onboarding',
      authorizationParams: { screen_hint: 'signup' },
    });
  });
});
