'use client';

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { loadConfig } from '../runtime-config';
import {
  beginLogin,
  clearTokens,
  decodeIdTokenClaims,
  loadStoredTokens,
  type TokenSet,
} from './cognito-pkce';

export interface AuthUser {
  email: string;
  name?: string;
  picture?: string;
  roles: string[];
}

export interface AuthSession {
  user: AuthUser;
  idToken: string;
  accessToken: string;
  expires: string;
}

interface AuthState {
  /** null = unauthenticated, undefined = still loading initial state */
  session: AuthSession | null | undefined;
  signIn: () => void;
  signOut: () => void;
  setTokens: (tokens: TokenSet) => void;
}

const AuthContext = createContext<AuthState | null>(null);

function tokensToSession(tokens: TokenSet): AuthSession | null {
  const claims = decodeIdTokenClaims(tokens.idToken);
  if (!claims?.email) return null;
  return {
    user: {
      email: claims.email,
      name: claims.name,
      picture: claims.picture,
      roles: claims['cognito:groups'] ?? [],
    },
    idToken: tokens.idToken,
    accessToken: tokens.accessToken,
    expires: new Date(tokens.expiresAt).toISOString(),
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AuthSession | null | undefined>(
    undefined,
  );

  useEffect(() => {
    const stored = loadStoredTokens();
    setSession(stored ? tokensToSession(stored) : null);
  }, []);

  const triggerSignIn = useCallback(() => {
    void (async () => {
      const config = await loadConfig();
      await beginLogin(config);
    })();
  }, []);

  const triggerSignOut = useCallback(() => {
    clearTokens();
    setSession(null);
  }, []);

  const setTokens = useCallback((tokens: TokenSet) => {
    setSession(tokensToSession(tokens));
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      session,
      signIn: triggerSignIn,
      signOut: triggerSignOut,
      setTokens,
    }),
    [session, triggerSignIn, triggerSignOut, setTokens],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
