import { render } from '@testing-library/react';
import { useRouter } from 'next/navigation';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuth } from '@/lib/auth/auth-context';
import HomePage from '../page';

const replaceMock = vi.fn();

vi.mock('@/lib/auth/auth-context', () => ({
  useAuth: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(),
}));

describe('HomePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useRouter).mockReturnValue({
      replace: replaceMock,
    } as unknown as ReturnType<typeof useRouter>);
  });

  it('session が undefined のうちは redirect しないべき', () => {
    vi.mocked(useAuth).mockReturnValue({
      session: undefined,
      signIn: vi.fn(),
      signOut: vi.fn(),
      setTokens: vi.fn(),
    });
    render(<HomePage />);
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('session が null なら /login へ遷移すべき', () => {
    vi.mocked(useAuth).mockReturnValue({
      session: null,
      signIn: vi.fn(),
      signOut: vi.fn(),
      setTokens: vi.fn(),
    });
    render(<HomePage />);
    expect(replaceMock).toHaveBeenCalledWith('/login');
  });

  it('session が認証済みなら /dashboard へ遷移すべき', () => {
    vi.mocked(useAuth).mockReturnValue({
      session: {
        user: { email: 'a@e.com', roles: [] },
        idToken: 'i',
        accessToken: 'a',
        expires: new Date(Date.now() + 60_000).toISOString(),
      },
      signIn: vi.fn(),
      signOut: vi.fn(),
      setTokens: vi.fn(),
    });
    render(<HomePage />);
    expect(replaceMock).toHaveBeenCalledWith('/dashboard');
  });
});
