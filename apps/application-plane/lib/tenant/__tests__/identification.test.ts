/**
 * テナント識別ロジック テスト
 */

import { describe, expect, it } from 'vitest';
import type { NextRequest } from 'next/server';
import {
  getTenantSlugFromUrl,
  getTenantSlugFromSubdomain,
  getTenantSlugFromQueryParam,
  buildApplicationPlaneUrl,
  isValidTenantSlug,
} from '../identification';

// NextRequest のモックファクトリ
function createMockRequest(
  url: string,
  headers: Record<string, string> = {}
): NextRequest {
  const parsedUrl = new URL(url);
  return {
    nextUrl: parsedUrl,
    url,
    headers: new Map(Object.entries(headers)),
  } as unknown as NextRequest;
}

describe('テナント識別ロジック', () => {
  describe('getTenantSlugFromSubdomain', () => {
    it('サブドメインからテナントスラッグを取得すべき', () => {
      const req = createMockRequest('https://acme.tenka.cloud/dashboard');
      expect(getTenantSlugFromSubdomain(req)).toBe('acme');
    });

    it('複数サブドメインの場合は最初のセグメントを取得すべき', () => {
      const req = createMockRequest(
        'https://acme.staging.tenka.cloud/dashboard'
      );
      expect(getTenantSlugFromSubdomain(req)).toBe('acme');
    });

    it('www サブドメインは無視すべき', () => {
      const req = createMockRequest('https://www.tenka.cloud/dashboard');
      expect(getTenantSlugFromSubdomain(req)).toBeNull();
    });

    it('サブドメインがない場合は null を返すべき', () => {
      const req = createMockRequest('https://tenka.cloud/dashboard');
      expect(getTenantSlugFromSubdomain(req)).toBeNull();
    });

    it('localhost の場合は null を返すべき', () => {
      const req = createMockRequest('http://localhost:13001/dashboard');
      expect(getTenantSlugFromSubdomain(req)).toBeNull();
    });

    it('IP アドレスの場合は null を返すべき', () => {
      const req = createMockRequest('http://192.168.1.1:3000/dashboard');
      expect(getTenantSlugFromSubdomain(req)).toBeNull();
    });

    it('予約済みサブドメイン（api）は null を返すべき', () => {
      const req = createMockRequest('https://api.tenka.cloud/dashboard');
      expect(getTenantSlugFromSubdomain(req)).toBeNull();
    });

    it('予約済みサブドメイン（admin）は null を返すべき', () => {
      const req = createMockRequest('https://admin.tenka.cloud/dashboard');
      expect(getTenantSlugFromSubdomain(req)).toBeNull();
    });

    it('予約済みサブドメイン（staging）は null を返すべき', () => {
      const req = createMockRequest('https://staging.tenka.cloud/dashboard');
      expect(getTenantSlugFromSubdomain(req)).toBeNull();
    });
  });

  describe('getTenantSlugFromQueryParam', () => {
    it('クエリパラメータからテナントスラッグを取得すべき', () => {
      const req = createMockRequest(
        'http://localhost:13001/dashboard?tenant=acme'
      );
      expect(getTenantSlugFromQueryParam(req)).toBe('acme');
    });

    it('クエリパラメータがない場合は null を返すべき', () => {
      const req = createMockRequest('http://localhost:13001/dashboard');
      expect(getTenantSlugFromQueryParam(req)).toBeNull();
    });

    it('空のクエリパラメータの場合は null を返すべき', () => {
      const req = createMockRequest('http://localhost:13001/dashboard?tenant=');
      expect(getTenantSlugFromQueryParam(req)).toBeNull();
    });
  });

  describe('getTenantSlugFromUrl', () => {
    it('本番環境ではサブドメインを優先すべき', () => {
      const req = createMockRequest(
        'https://acme.tenka.cloud/dashboard?tenant=other'
      );
      expect(getTenantSlugFromUrl(req)).toBe('acme');
    });

    it('開発環境ではクエリパラメータを使用すべき', () => {
      const req = createMockRequest(
        'http://localhost:13001/dashboard?tenant=acme'
      );
      expect(getTenantSlugFromUrl(req)).toBe('acme');
    });

    it('どちらもない場合は null を返すべき', () => {
      const req = createMockRequest('http://localhost:13001/dashboard');
      expect(getTenantSlugFromUrl(req)).toBeNull();
    });
  });

  describe('buildApplicationPlaneUrl', () => {
    it('本番環境ではサブドメイン URL を生成すべき', () => {
      const url = buildApplicationPlaneUrl('acme', '/admin', true);
      expect(url).toBe('https://acme.tenka.cloud/admin');
    });

    it('開発環境ではクエリパラメータ付き URL を生成すべき', () => {
      const url = buildApplicationPlaneUrl('acme', '/admin', false);
      expect(url).toBe('http://localhost:13001/admin?tenant=acme');
    });

    it('既存のクエリパラメータがある場合は追加すべき', () => {
      const url = buildApplicationPlaneUrl('acme', '/admin?view=list', false);
      expect(url).toBe('http://localhost:13001/admin?view=list&tenant=acme');
    });

    it('デフォルトパスはルートにすべき', () => {
      const url = buildApplicationPlaneUrl('acme');
      expect(url).toContain('acme');
    });
  });

  describe('isValidTenantSlug', () => {
    it('有効なスラッグを受け入れるべき', () => {
      expect(isValidTenantSlug('acme')).toBe(true);
      expect(isValidTenantSlug('my-company')).toBe(true);
      expect(isValidTenantSlug('tenant123')).toBe(true);
      expect(isValidTenantSlug('a-b-c')).toBe(true);
    });

    it('無効なスラッグを拒否すべき', () => {
      expect(isValidTenantSlug('')).toBe(false);
      expect(isValidTenantSlug('www')).toBe(false);
      expect(isValidTenantSlug('api')).toBe(false);
      expect(isValidTenantSlug('admin')).toBe(false);
      expect(isValidTenantSlug('UPPERCASE')).toBe(false);
      expect(isValidTenantSlug('with space')).toBe(false);
      expect(isValidTenantSlug('with_underscore')).toBe(false);
      expect(isValidTenantSlug('-start-with-dash')).toBe(false);
      expect(isValidTenantSlug('end-with-dash-')).toBe(false);
      expect(isValidTenantSlug('a'.repeat(64))).toBe(false);
    });

    it('予約語を拒否すべき', () => {
      expect(isValidTenantSlug('www')).toBe(false);
      expect(isValidTenantSlug('api')).toBe(false);
      expect(isValidTenantSlug('admin')).toBe(false);
      expect(isValidTenantSlug('app')).toBe(false);
      expect(isValidTenantSlug('staging')).toBe(false);
      expect(isValidTenantSlug('production')).toBe(false);
    });
  });
});
