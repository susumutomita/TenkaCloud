import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { NextResponse } from 'next/server';
import type { Session } from 'next-auth';

// Mock auth module
const mockAuth = vi.fn<() => Promise<Session | null>>();

vi.mock('@/auth', () => ({
  auth: () => mockAuth(),
}));

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('Server API Utilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.resetModules();
  });

  describe('レスポンスヘルパー', () => {
    it('unauthorizedResponse は 401 ステータスを返すべき', async () => {
      const { unauthorizedResponse } = await import('../server');
      const response = unauthorizedResponse('テストエラー');

      expect(response).toBeInstanceOf(NextResponse);
      expect(response.status).toBe(401);

      const data = await response.json();
      expect(data.error).toBe('テストエラー');
    });

    it('unauthorizedResponse はデフォルトメッセージを使用すべき', async () => {
      const { unauthorizedResponse } = await import('../server');
      const response = unauthorizedResponse();

      const data = await response.json();
      expect(data.error).toBe('Unauthorized');
    });

    it('forbiddenResponse は 403 ステータスを返すべき', async () => {
      const { forbiddenResponse } = await import('../server');
      const response = forbiddenResponse('権限なし');

      expect(response.status).toBe(403);

      const data = await response.json();
      expect(data.error).toBe('権限なし');
    });

    it('badRequestResponse は 400 ステータスを返すべき', async () => {
      const { badRequestResponse } = await import('../server');
      const response = badRequestResponse('不正なリクエスト');

      expect(response.status).toBe(400);

      const data = await response.json();
      expect(data.error).toBe('不正なリクエスト');
    });

    it('successResponse は指定されたデータとステータスを返すべき', async () => {
      const { successResponse } = await import('../server');
      const testData = { id: '123', name: 'test' };
      const response = successResponse(testData, 201);

      expect(response.status).toBe(201);

      const data = await response.json();
      expect(data).toEqual(testData);
    });

    it('successResponse はデフォルトで 200 ステータスを返すべき', async () => {
      const { successResponse } = await import('../server');
      const response = successResponse({ ok: true });

      expect(response.status).toBe(200);
    });
  });

  describe('getAdminSession', () => {
    it('未認証の場合は null を返すべき', async () => {
      mockAuth.mockResolvedValue(null);

      const { getAdminSession } = await import('../server');
      const result = await getAdminSession();

      expect(result).toBeNull();
    });

    it('admin ロールがない場合は null を返すべき', async () => {
      mockAuth.mockResolvedValue({
        user: { name: 'User', email: 'user@example.com' },
        expires: new Date().toISOString(),
        roles: ['participant'],
      } as Session);

      const { getAdminSession } = await import('../server');
      const result = await getAdminSession();

      expect(result).toBeNull();
    });

    it('admin ロールがある場合はセッションを返すべき', async () => {
      const session: Session = {
        user: { name: 'Admin', email: 'admin@example.com' },
        expires: new Date().toISOString(),
        roles: ['admin', 'participant'],
        accessToken: 'test-token',
      };
      mockAuth.mockResolvedValue(session);

      const { getAdminSession } = await import('../server');
      const result = await getAdminSession();

      expect(result).toEqual(session);
    });

    it('roles が undefined の場合は null を返すべき', async () => {
      mockAuth.mockResolvedValue({
        user: { name: 'User', email: 'user@example.com' },
        expires: new Date().toISOString(),
      } as Session);

      const { getAdminSession } = await import('../server');
      const result = await getAdminSession();

      expect(result).toBeNull();
    });
  });

  describe('serverApiRequest', () => {
    it('認証トークン付きでリクエストを送信すべき', async () => {
      mockAuth.mockResolvedValue({
        user: { name: 'User', email: 'user@example.com' },
        expires: new Date().toISOString(),
        accessToken: 'test-access-token',
      } as Session);

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: 'test' }),
      });

      const { serverApiRequest } = await import('../server');
      const result = await serverApiRequest<{ data: string }>('/test-endpoint');

      expect(result).toEqual({ data: 'test' });
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/test-endpoint'),
        expect.objectContaining({
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            Authorization: 'Bearer test-access-token',
          }),
        })
      );
    });

    it('未認証の場合は Authorization ヘッダーなしでリクエストを送信すべき', async () => {
      mockAuth.mockResolvedValue(null);

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: 'test' }),
      });

      const { serverApiRequest } = await import('../server');
      await serverApiRequest<{ data: string }>('/test-endpoint');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/test-endpoint'),
        expect.objectContaining({
          headers: expect.not.objectContaining({
            Authorization: expect.any(String),
          }),
        })
      );
    });

    it('API エラーの場合はエラーをスローすべき', async () => {
      mockAuth.mockResolvedValue(null);

      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: 'Internal server error' }),
      });

      const { serverApiRequest } = await import('../server');

      await expect(serverApiRequest('/test-endpoint')).rejects.toThrow(
        'Internal server error'
      );
    });

    it('JSON パースエラーの場合はステータスを含むエラーをスローすべき', async () => {
      mockAuth.mockResolvedValue(null);

      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        json: () => Promise.reject(new Error('Invalid JSON')),
      });

      const { serverApiRequest } = await import('../server');

      await expect(serverApiRequest('/test-endpoint')).rejects.toThrow(
        'HTTP error! status: 404'
      );
    });

    it('カスタムオプションを渡せるべき', async () => {
      mockAuth.mockResolvedValue(null);

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      });

      const { serverApiRequest } = await import('../server');
      await serverApiRequest('/test-endpoint', {
        method: 'POST',
        body: JSON.stringify({ key: 'value' }),
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ key: 'value' }),
        })
      );
    });
  });
});
