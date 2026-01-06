/**
 * テナントコンテキスト テスト
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  TenantProvider,
  useTenant,
  useTenantOptional,
  type TenantInfo,
} from '../context';

// テスト用コンポーネント
function TestComponent() {
  const tenant = useTenant();
  return (
    <div>
      <span data-testid="slug">{tenant.slug || 'no-slug'}</span>
      <span data-testid="loading">
        {tenant.isLoading ? 'loading' : 'loaded'}
      </span>
      <span data-testid="role">{tenant.userRole || 'no-role'}</span>
    </div>
  );
}

// テスト用コンポーネント: useTenantOptional
function TestOptionalComponent() {
  const tenant = useTenantOptional();
  return (
    <div>
      <span data-testid="optional-slug">{tenant?.slug ?? 'no-context'}</span>
      <span data-testid="optional-loading">
        {tenant === null ? 'null' : tenant.isLoading ? 'loading' : 'loaded'}
      </span>
    </div>
  );
}

describe('TenantContext', () => {
  describe('TenantProvider', () => {
    it('初期値を提供すべき', () => {
      const initialTenant: TenantInfo = {
        slug: 'test-tenant',
        isLoading: false,
        userRole: 'participant',
      };

      render(
        <TenantProvider initialTenant={initialTenant}>
          <TestComponent />
        </TenantProvider>
      );

      expect(screen.getByTestId('slug')).toHaveTextContent('test-tenant');
      expect(screen.getByTestId('loading')).toHaveTextContent('loaded');
      expect(screen.getByTestId('role')).toHaveTextContent('participant');
    });

    it('デフォルト値でもレンダリングすべき', () => {
      render(
        <TenantProvider>
          <TestComponent />
        </TenantProvider>
      );

      expect(screen.getByTestId('slug')).toHaveTextContent('no-slug');
      expect(screen.getByTestId('loading')).toHaveTextContent('loading');
    });

    it('admin ロールを正しく設定すべき', () => {
      const initialTenant: TenantInfo = {
        slug: 'admin-tenant',
        isLoading: false,
        userRole: 'admin',
      };

      render(
        <TenantProvider initialTenant={initialTenant}>
          <TestComponent />
        </TenantProvider>
      );

      expect(screen.getByTestId('role')).toHaveTextContent('admin');
    });
  });

  describe('useTenant', () => {
    it('Provider 外で使用するとエラーをスローすべき', () => {
      // console.error を抑制
      const consoleSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      expect(() => {
        render(<TestComponent />);
      }).toThrow('useTenant must be used within a TenantProvider');

      consoleSpy.mockRestore();
    });
  });

  describe('useTenantOptional', () => {
    it('Provider 外で使用すると null を返すべき', () => {
      render(<TestOptionalComponent />);

      expect(screen.getByTestId('optional-slug')).toHaveTextContent(
        'no-context'
      );
      expect(screen.getByTestId('optional-loading')).toHaveTextContent('null');
    });

    it('Provider 内ではテナント情報を取得できるべき', () => {
      const initialTenant: TenantInfo = {
        slug: 'optional-tenant',
        isLoading: false,
      };

      render(
        <TenantProvider initialTenant={initialTenant}>
          <TestOptionalComponent />
        </TenantProvider>
      );

      expect(screen.getByTestId('optional-slug')).toHaveTextContent(
        'optional-tenant'
      );
      expect(screen.getByTestId('optional-loading')).toHaveTextContent(
        'loaded'
      );
    });
  });
});
