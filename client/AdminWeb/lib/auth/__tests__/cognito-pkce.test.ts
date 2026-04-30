import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../runtime-config';
import {
  beginLogin,
  clearTokens,
  completeLogin,
  decodeIdTokenClaims,
  getCurrentIdToken,
  loadStoredTokens,
} from '../cognito-pkce';

const config: AppConfig = {
  cognitoDomain: 'https://example.auth.region.amazoncognito.com',
  cognitoClientId: 'client-abc',
  apiBaseUrl: 'https://api.example.com',
  redirectUri: 'https://app.example.com/callback',
  scope: 'openid email profile',
};

function makeIdToken(claims: Record<string, unknown>): string {
  const header = btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = btoa(JSON.stringify(claims))
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `${header}.${payload}.signature`;
}

describe('cognito-pkce', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('beginLogin', () => {
    it('verifier と state を sessionStorage に保存すべき', async () => {
      const assign = vi.fn();
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: { ...window.location, assign },
      });

      await beginLogin(config);

      expect(sessionStorage.getItem('tenkacloud.pkce_verifier')).toBeTruthy();
      expect(sessionStorage.getItem('tenkacloud.oauth_state')).toBeTruthy();
      expect(assign).toHaveBeenCalledOnce();
      const target = new URL(assign.mock.calls[0][0] as string);
      expect(target.origin + target.pathname).toBe(
        `${config.cognitoDomain}/oauth2/authorize`,
      );
      expect(target.searchParams.get('client_id')).toBe(config.cognitoClientId);
      expect(target.searchParams.get('response_type')).toBe('code');
      expect(target.searchParams.get('code_challenge_method')).toBe('S256');
    });
  });

  describe('completeLogin', () => {
    it('verifier が無いと throw すべき', async () => {
      await expect(completeLogin(config, 'code', 'state')).rejects.toThrow(
        /PKCE verifier missing/,
      );
    });

    it('state が一致しないと throw すべき', async () => {
      sessionStorage.setItem('tenkacloud.pkce_verifier', 'v');
      sessionStorage.setItem('tenkacloud.oauth_state', 'expected');
      await expect(completeLogin(config, 'code', 'wrong')).rejects.toThrow(
        /OAuth state mismatch/,
      );
    });

    it('state が sessionStorage に無いと throw すべき', async () => {
      sessionStorage.setItem('tenkacloud.pkce_verifier', 'v');
      await expect(completeLogin(config, 'code', 'anything')).rejects.toThrow(
        /OAuth state mismatch/,
      );
    });

    it('Cognito エラー応答を throw すべき', async () => {
      sessionStorage.setItem('tenkacloud.pkce_verifier', 'v');
      sessionStorage.setItem('tenkacloud.oauth_state', 's');
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(new Response('invalid_grant', { status: 400 })),
      );
      await expect(completeLogin(config, 'code', 's')).rejects.toThrow(
        /Cognito token exchange failed/,
      );
    });

    it('成功時にトークンを保存して返すべき', async () => {
      sessionStorage.setItem('tenkacloud.pkce_verifier', 'verifier');
      sessionStorage.setItem('tenkacloud.oauth_state', 'state');
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              id_token: 'idt',
              access_token: 'at',
              refresh_token: 'rt',
              expires_in: 3600,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        ),
      );

      const tokens = await completeLogin(config, 'code', 'state');

      expect(tokens.idToken).toBe('idt');
      expect(tokens.accessToken).toBe('at');
      expect(tokens.refreshToken).toBe('rt');
      expect(tokens.expiresAt).toBeGreaterThan(Date.now());
      expect(sessionStorage.getItem('tenkacloud.tokens')).toBeTruthy();
      expect(sessionStorage.getItem('tenkacloud.pkce_verifier')).toBeNull();
      expect(sessionStorage.getItem('tenkacloud.oauth_state')).toBeNull();
    });
  });

  describe('loadStoredTokens', () => {
    it('トークンが無ければ null を返すべき', () => {
      expect(loadStoredTokens()).toBeNull();
    });

    it('期限切れトークンは削除して null を返すべき', () => {
      sessionStorage.setItem(
        'tenkacloud.tokens',
        JSON.stringify({
          idToken: 'i',
          accessToken: 'a',
          expiresAt: Date.now() - 1000,
        }),
      );
      expect(loadStoredTokens()).toBeNull();
      expect(sessionStorage.getItem('tenkacloud.tokens')).toBeNull();
    });

    it('JSON が壊れていれば削除して null を返すべき', () => {
      sessionStorage.setItem('tenkacloud.tokens', 'not-json');
      expect(loadStoredTokens()).toBeNull();
      expect(sessionStorage.getItem('tenkacloud.tokens')).toBeNull();
    });

    it('有効なトークンを返すべき', () => {
      const tokens = {
        idToken: 'i',
        accessToken: 'a',
        expiresAt: Date.now() + 60_000,
      };
      sessionStorage.setItem('tenkacloud.tokens', JSON.stringify(tokens));
      expect(loadStoredTokens()).toEqual(tokens);
    });
  });

  describe('clearTokens', () => {
    it('全関連 key を削除すべき', () => {
      sessionStorage.setItem('tenkacloud.tokens', 'x');
      sessionStorage.setItem('tenkacloud.pkce_verifier', 'x');
      sessionStorage.setItem('tenkacloud.oauth_state', 'x');
      clearTokens();
      expect(sessionStorage.getItem('tenkacloud.tokens')).toBeNull();
      expect(sessionStorage.getItem('tenkacloud.pkce_verifier')).toBeNull();
      expect(sessionStorage.getItem('tenkacloud.oauth_state')).toBeNull();
    });
  });

  describe('decodeIdTokenClaims', () => {
    it('3 segments で無いと null を返すべき', () => {
      expect(decodeIdTokenClaims('abc')).toBeNull();
      expect(decodeIdTokenClaims('a.b')).toBeNull();
      expect(decodeIdTokenClaims('a.b.c.d')).toBeNull();
    });

    it('payload が壊れていれば null を返すべき', () => {
      expect(decodeIdTokenClaims('header.not-base64!.sig')).toBeNull();
    });

    it('claims を decode すべき', () => {
      const token = makeIdToken({
        email: 'user@example.com',
        name: 'Alice',
        'cognito:groups': ['admin'],
      });
      const claims = decodeIdTokenClaims(token);
      expect(claims?.email).toBe('user@example.com');
      expect(claims?.name).toBe('Alice');
      expect(claims?.['cognito:groups']).toEqual(['admin']);
    });
  });

  describe('getCurrentIdToken', () => {
    it('トークンが無ければ null を返すべき', () => {
      expect(getCurrentIdToken()).toBeNull();
    });

    it('保存されたトークンの idToken を返すべき', () => {
      sessionStorage.setItem(
        'tenkacloud.tokens',
        JSON.stringify({
          idToken: 'idt',
          accessToken: 'at',
          expiresAt: Date.now() + 60_000,
        }),
      );
      expect(getCurrentIdToken()).toBe('idt');
    });
  });
});
