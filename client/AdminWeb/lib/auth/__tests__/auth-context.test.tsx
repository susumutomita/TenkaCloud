import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from '../auth-context';

vi.mock('../cognito-pkce', () => ({
  loadStoredTokens: vi.fn(),
  decodeIdTokenClaims: vi.fn(),
  beginLogin: vi.fn(),
  clearTokens: vi.fn(),
}));

vi.mock('../../runtime-config', () => ({
  loadConfig: vi.fn().mockResolvedValue({
    cognitoDomain: 'https://cognito.example.com',
    cognitoClientId: 'cid',
    apiBaseUrl: 'https://api.example.com',
    redirectUri: 'https://app.example.com/callback',
    scope: 'openid email profile',
  }),
}));

import { loadConfig } from '../../runtime-config';
import {
  beginLogin,
  clearTokens,
  decodeIdTokenClaims,
  loadStoredTokens,
  type TokenSet,
} from '../cognito-pkce';

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <AuthProvider>{children}</AuthProvider>
);

describe('AuthProvider / useAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('useAuth は AuthProvider 外で呼ぶと throw すべき', () => {
    expect(() => renderHook(() => useAuth())).toThrow(
      /useAuth must be used inside <AuthProvider>/,
    );
  });

  it('保存された有効トークンから session を組み立てるべき', async () => {
    vi.mocked(loadStoredTokens).mockReturnValue({
      idToken: 'i',
      accessToken: 'a',
      expiresAt: Date.now() + 60_000,
    });
    vi.mocked(decodeIdTokenClaims).mockReturnValue({
      email: 'user@example.com',
      name: 'Alice',
      'cognito:groups': ['admin'],
    });

    const { result } = renderHook(() => useAuth(), { wrapper });

    await vi.waitFor(() => {
      expect(result.current.session).toBeTruthy();
    });
    expect(result.current.session?.user.email).toBe('user@example.com');
    expect(result.current.session?.user.name).toBe('Alice');
    expect(result.current.session?.user.roles).toEqual(['admin']);
  });

  it('email が無いトークンは session を null にすべき', async () => {
    vi.mocked(loadStoredTokens).mockReturnValue({
      idToken: 'i',
      accessToken: 'a',
      expiresAt: Date.now() + 60_000,
    });
    vi.mocked(decodeIdTokenClaims).mockReturnValue({});

    const { result } = renderHook(() => useAuth(), { wrapper });

    await vi.waitFor(() => {
      expect(result.current.session).toBeNull();
    });
  });

  it('保存トークンが無いと session は null になるべき', async () => {
    vi.mocked(loadStoredTokens).mockReturnValue(null);

    const { result } = renderHook(() => useAuth(), { wrapper });

    await vi.waitFor(() => {
      expect(result.current.session).toBeNull();
    });
  });

  it('signIn は loadConfig + beginLogin を呼ぶべき', async () => {
    vi.mocked(loadStoredTokens).mockReturnValue(null);
    const { result } = renderHook(() => useAuth(), { wrapper });
    await vi.waitFor(() => {
      expect(result.current.session).toBeNull();
    });

    act(() => {
      result.current.signIn();
    });

    await vi.waitFor(() => {
      expect(loadConfig).toHaveBeenCalled();
      expect(beginLogin).toHaveBeenCalled();
    });
  });

  it('signOut は clearTokens を呼んで session を null にすべき', async () => {
    vi.mocked(loadStoredTokens).mockReturnValue({
      idToken: 'i',
      accessToken: 'a',
      expiresAt: Date.now() + 60_000,
    });
    vi.mocked(decodeIdTokenClaims).mockReturnValue({
      email: 'user@example.com',
    });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await vi.waitFor(() => {
      expect(result.current.session?.user.email).toBe('user@example.com');
    });

    act(() => {
      result.current.signOut();
    });

    expect(clearTokens).toHaveBeenCalled();
    expect(result.current.session).toBeNull();
  });

  it('setTokens で session を更新できるべき', async () => {
    vi.mocked(loadStoredTokens).mockReturnValue(null);
    vi.mocked(decodeIdTokenClaims).mockReturnValue({
      email: 'new@example.com',
    });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await vi.waitFor(() => {
      expect(result.current.session).toBeNull();
    });

    const tokens: TokenSet = {
      idToken: 'new-i',
      accessToken: 'new-a',
      expiresAt: Date.now() + 60_000,
    };
    act(() => {
      result.current.setTokens(tokens);
    });

    expect(result.current.session?.user.email).toBe('new@example.com');
  });
});
