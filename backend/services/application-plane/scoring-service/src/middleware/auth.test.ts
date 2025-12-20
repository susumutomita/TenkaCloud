import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { authMiddleware } from './auth';
import * as jose from 'jose';

vi.mock('jose', async () => {
  const actual = await vi.importActual('jose');
  return {
    ...actual,
    createRemoteJWKSet: vi.fn(),
    jwtVerify: vi.fn(),
    errors: {
      JWTExpired: class JWTExpired extends Error {
        constructor(
          message: string,
          _claim: string,
          _payload: Record<string, unknown>
        ) {
          super(message);
          this.name = 'JWTExpired';
        }
      },
      JWTClaimValidationFailed: class JWTClaimValidationFailed extends Error {
        constructor(
          message: string,
          _claim: string,
          _reason: string,
          _payload: Record<string, unknown>
        ) {
          super(message);
          this.name = 'JWTClaimValidationFailed';
        }
      },
    },
  };
});

describe('認証ミドルウェア', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.use('/*', authMiddleware);
    app.get('/test', (c) => c.json({ auth: c.get('auth') }));
  });

  it('有効なトークンで認証が成功するべき', async () => {
    const mockPayload = {
      sub: 'user-123',
      tenant_id: 'tenant-456',
      realm_access: { roles: ['user'] },
    };

    vi.mocked(jose.createRemoteJWKSet).mockReturnValue(vi.fn() as never);
    vi.mocked(jose.jwtVerify).mockResolvedValue({
      payload: mockPayload,
      protectedHeader: { alg: 'RS256' },
    } as never);

    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer valid-token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.auth).toEqual({
      userId: 'user-123',
      tenantId: 'tenant-456',
      roles: ['user'],
    });
  });

  it('Authorizationヘッダーがない場合は401を返すべき', async () => {
    const res = await app.request('/test');

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('認証が必要です');
  });

  it('Bearerトークンでない場合は401を返すべき', async () => {
    const res = await app.request('/test', {
      headers: { Authorization: 'Basic abc123' },
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('認証が必要です');
  });

  it('テナントIDがない場合は403を返すべき', async () => {
    const mockPayload = {
      sub: 'user-123',
      realm_access: { roles: ['user'] },
    };

    vi.mocked(jose.createRemoteJWKSet).mockReturnValue(vi.fn() as never);
    vi.mocked(jose.jwtVerify).mockResolvedValue({
      payload: mockPayload,
      protectedHeader: { alg: 'RS256' },
    } as never);

    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer valid-token' },
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('テナント情報がありません');
  });

  it('期限切れトークンの場合は401を返すべき', async () => {
    vi.mocked(jose.createRemoteJWKSet).mockReturnValue(vi.fn() as never);
    const error = new Error('expired');
    error.name = 'JWTExpired';
    Object.setPrototypeOf(error, jose.errors.JWTExpired.prototype);
    vi.mocked(jose.jwtVerify).mockRejectedValue(error);

    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer expired-token' },
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('トークンの有効期限が切れています');
  });

  it('無効なトークンの場合は401を返すべき', async () => {
    vi.mocked(jose.createRemoteJWKSet).mockReturnValue(vi.fn() as never);
    const error = new Error('invalid');
    error.name = 'JWTClaimValidationFailed';
    Object.setPrototypeOf(
      error,
      jose.errors.JWTClaimValidationFailed.prototype
    );
    vi.mocked(jose.jwtVerify).mockRejectedValue(error);

    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer invalid-token' },
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('トークンの検証に失敗しました');
  });

  it('その他のエラーの場合は401を返すべき', async () => {
    vi.mocked(jose.createRemoteJWKSet).mockReturnValue(vi.fn() as never);
    vi.mocked(jose.jwtVerify).mockRejectedValue(new Error('unknown error'));

    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer bad-token' },
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('認証に失敗しました');
  });

  it('subがundefinedの場合は空文字をuserIdとするべき', async () => {
    const mockPayload = {
      tenant_id: 'tenant-456',
      realm_access: { roles: ['user'] },
    };

    vi.mocked(jose.createRemoteJWKSet).mockReturnValue(vi.fn() as never);
    vi.mocked(jose.jwtVerify).mockResolvedValue({
      payload: mockPayload,
      protectedHeader: { alg: 'RS256' },
    } as never);

    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer valid-token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.auth.userId).toBe('');
    expect(body.auth.tenantId).toBe('tenant-456');
  });

  it('realm_accessがない場合は空配列をrolesとするべき', async () => {
    const mockPayload = {
      sub: 'user-123',
      tenant_id: 'tenant-456',
    };

    vi.mocked(jose.createRemoteJWKSet).mockReturnValue(vi.fn() as never);
    vi.mocked(jose.jwtVerify).mockResolvedValue({
      payload: mockPayload,
      protectedHeader: { alg: 'RS256' },
    } as never);

    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer valid-token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.auth.roles).toEqual([]);
  });

  it('realm_accessにrolesがない場合は空配列をrolesとするべき', async () => {
    const mockPayload = {
      sub: 'user-123',
      tenant_id: 'tenant-456',
      realm_access: {},
    };

    vi.mocked(jose.createRemoteJWKSet).mockReturnValue(vi.fn() as never);
    vi.mocked(jose.jwtVerify).mockResolvedValue({
      payload: mockPayload,
      protectedHeader: { alg: 'RS256' },
    } as never);

    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer valid-token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.auth.roles).toEqual([]);
  });
});
