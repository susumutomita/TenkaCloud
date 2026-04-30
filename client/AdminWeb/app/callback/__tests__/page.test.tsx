import { render, screen, waitFor } from '@testing-library/react';
import { useRouter, useSearchParams } from 'next/navigation';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuth } from '@/lib/auth/auth-context';
import { completeLogin } from '@/lib/auth/cognito-pkce';
import { loadConfig } from '@/lib/runtime-config';
import CallbackPage from '../page';

const replaceMock = vi.fn();
const setTokensMock = vi.fn();
const getMock = vi.fn();

vi.mock('@/lib/auth/auth-context', () => ({
  useAuth: vi.fn(),
}));

vi.mock('@/lib/auth/cognito-pkce', () => ({
  completeLogin: vi.fn(),
}));

vi.mock('@/lib/runtime-config', () => ({
  loadConfig: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(),
  useSearchParams: vi.fn(),
}));

vi.mock('@cloudscape-design/components/box', () => ({
  default: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock('@cloudscape-design/components/container', () => ({
  default: ({
    children,
    header,
  }: {
    children?: React.ReactNode;
    header?: React.ReactNode;
  }) => (
    <div>
      {header}
      {children}
    </div>
  ),
}));

vi.mock('@cloudscape-design/components/header', () => ({
  default: ({ children }: { children?: React.ReactNode }) => (
    <h1>{children}</h1>
  ),
}));

vi.mock('@cloudscape-design/components/status-indicator', () => ({
  default: ({ children }: { children?: React.ReactNode }) => (
    <output>{children}</output>
  ),
}));

vi.mock('@cloudscape-design/global-styles/index.css', () => ({}));

describe('CallbackPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useRouter).mockReturnValue({
      replace: replaceMock,
    } as unknown as ReturnType<typeof useRouter>);
    vi.mocked(useSearchParams).mockReturnValue({
      get: getMock,
    } as unknown as ReturnType<typeof useSearchParams>);
    vi.mocked(useAuth).mockReturnValue({
      session: undefined,
      signIn: vi.fn(),
      signOut: vi.fn(),
      setTokens: setTokensMock,
    });
  });

  it('error クエリがあるとエラーを表示すべき', async () => {
    getMock.mockImplementation((key: string) =>
      key === 'error' ? 'access_denied' : null,
    );
    render(<CallbackPage />);
    expect(
      await screen.findByText(/Cognito returned an error: access_denied/),
    ).toBeInTheDocument();
  });

  it('code クエリが無いとエラーを表示すべき', async () => {
    getMock.mockReturnValue(null);
    render(<CallbackPage />);
    expect(
      await screen.findByText(/Authorization code missing/),
    ).toBeInTheDocument();
  });

  it('code を交換して /dashboard へ遷移すべき', async () => {
    getMock.mockImplementation((key: string) => {
      if (key === 'code') return 'auth-code';
      if (key === 'state') return 'state-value';
      return null;
    });
    vi.mocked(loadConfig).mockResolvedValue({
      cognitoDomain: 'https://cognito.example.com',
      cognitoClientId: 'cid',
      apiBaseUrl: 'https://api.example.com',
      redirectUri: 'https://app.example.com/callback',
      scope: 'openid email profile',
    });
    vi.mocked(completeLogin).mockResolvedValue({
      idToken: 'i',
      accessToken: 'a',
      expiresAt: Date.now() + 60_000,
    });

    render(<CallbackPage />);

    await waitFor(() => {
      expect(setTokensMock).toHaveBeenCalled();
    });
    expect(replaceMock).toHaveBeenCalledWith('/dashboard');
  });

  it('completeLogin の例外でエラー表示すべき', async () => {
    getMock.mockImplementation((key: string) =>
      key === 'code' ? 'auth-code' : null,
    );
    vi.mocked(loadConfig).mockResolvedValue({
      cognitoDomain: 'https://cognito.example.com',
      cognitoClientId: 'cid',
      apiBaseUrl: 'https://api.example.com',
      redirectUri: 'https://app.example.com/callback',
      scope: 'openid email profile',
    });
    vi.mocked(completeLogin).mockRejectedValue(new Error('exchange failed'));

    render(<CallbackPage />);

    expect(await screen.findByText(/exchange failed/)).toBeInTheDocument();
  });
});
