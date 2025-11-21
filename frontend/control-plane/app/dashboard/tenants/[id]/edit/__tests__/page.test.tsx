import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  render,
  screen,
  waitFor,
  fireEvent,
  act,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import EditTenantPage from '../page';
import { mockTenantApi } from '@/lib/api/mock-tenant-api';
import type { Tenant } from '@/types/tenant';

// Next.js の useRouter をモック
const mockPush = vi.fn();
const mockRefresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    refresh: mockRefresh,
  }),
}));

// mockTenantApi をモック
vi.mock('@/lib/api/mock-tenant-api', () => ({
  mockTenantApi: {
    getTenant: vi.fn(),
    updateTenant: vi.fn(),
  },
}));

// window.alert をモック
const mockAlert = vi.fn();
global.alert = mockAlert;

const renderPage = async (params: Promise<{ id: string }>) => {
  const result = render(<EditTenantPage params={params} />);

  // params の解決とそれに伴う state 更新を待機する
  await act(async () => {
    await params.catch(() => null);
  });

  return result;
};

describe('EditTenantPage', () => {
  const mockTenant: Tenant = {
    id: 'test-tenant-id',
    name: 'Test Tenant',
    adminEmail: 'admin@test.com',
    tier: 'pro',
    status: 'active',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('初期表示', () => {
    it('テナント情報を取得してフォームに表示するべき', async () => {
      vi.mocked(mockTenantApi.getTenant).mockResolvedValue(mockTenant);

      await renderPage(Promise.resolve({ id: 'test-tenant-id' }));

      await waitFor(() => {
        expect(mockTenantApi.getTenant).toHaveBeenCalledWith('test-tenant-id');
      });

      // データがロードされるまで待つ
      await waitFor(() => {
        expect(screen.getByLabelText('テナント名')).toHaveValue('Test Tenant');
        expect(screen.getByLabelText('管理者 Email')).toHaveValue(
          'admin@test.com'
        );
        expect(screen.getByLabelText('Tier')).toHaveValue('pro');
        expect(screen.getByLabelText('ステータス')).toHaveValue('active');
      });
    });

    it('テナントが見つからない場合、アラートを表示して一覧ページに戻るべき', async () => {
      vi.mocked(mockTenantApi.getTenant).mockResolvedValue(null);

      await renderPage(Promise.resolve({ id: 'nonexistent-id' }));

      await waitFor(() => {
        expect(mockAlert).toHaveBeenCalledWith('テナントが見つかりません');
        expect(mockPush).toHaveBeenCalledWith('/dashboard/tenants');
      });
    });

    it('テナント取得に失敗した場合、エラーメッセージが表示されるべき', async () => {
      const error = new Error('Failed to fetch');
      vi.mocked(mockTenantApi.getTenant).mockRejectedValue(error);

      await renderPage(Promise.resolve({ id: 'test-tenant-id' }));

      await waitFor(() => {
        expect(mockAlert).toHaveBeenCalledWith(
          'テナント情報の取得に失敗しました'
        );
      });
    });
  });

  describe('フォーム送信', () => {
    it('有効なデータで送信すると、テナントが更新され詳細ページに遷移するべき', async () => {
      const user = userEvent.setup();
      vi.mocked(mockTenantApi.getTenant).mockResolvedValue(mockTenant);
      vi.mocked(mockTenantApi.updateTenant).mockResolvedValue({
        ...mockTenant,
        name: 'Updated Tenant',
        adminEmail: 'updated@test.com',
      });

      await renderPage(Promise.resolve({ id: 'test-tenant-id' }));

      // フォームがロードされるまで待つ
      await screen.findByLabelText('テナント名');

      // フォームを送信
      const submitButton = screen.getByRole('button', { name: '更新' });
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(mockTenantApi.updateTenant).toHaveBeenCalledTimes(1);
        expect(mockPush).toHaveBeenCalledWith(
          '/dashboard/tenants/test-tenant-id'
        );
        expect(mockRefresh).toHaveBeenCalled();
      });
    });

    it('更新中は「更新中...」と表示され、ボタンが無効化されるべき', async () => {
      const user = userEvent.setup();
      vi.mocked(mockTenantApi.getTenant).mockResolvedValue(mockTenant);

      // updateTenant を遅延させて更新中の状態をテスト
      let resolveUpdate: (value: Tenant | null) => void;
      const updatePromise = new Promise<Tenant | null>((resolve) => {
        resolveUpdate = resolve;
      });
      vi.mocked(mockTenantApi.updateTenant).mockReturnValue(updatePromise);

      await renderPage(Promise.resolve({ id: 'test-tenant-id' }));

      await waitFor(() => {
        expect(screen.getByDisplayValue('Test Tenant')).toBeInTheDocument();
      });

      const submitButton = screen.getByRole('button', { name: '更新' });
      await user.click(submitButton);

      // 更新中の状態を確認
      await waitFor(() => {
        const updatingButton = screen.getByRole('button', {
          name: '更新中...',
        });
        expect(updatingButton).toBeDisabled();
      });

      // 更新を完了
      resolveUpdate!(mockTenant);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: '更新' })).not.toBeDisabled();
      });
    });

    it('更新失敗時にエラーメッセージが表示されるべき', async () => {
      const user = userEvent.setup();
      vi.mocked(mockTenantApi.getTenant).mockResolvedValue(mockTenant);
      const error = new Error('Update failed');
      vi.mocked(mockTenantApi.updateTenant).mockRejectedValue(error);

      await renderPage(Promise.resolve({ id: 'test-tenant-id' }));

      await waitFor(() => {
        expect(screen.getByLabelText('テナント名')).toHaveValue('Test Tenant');
      });

      const submitButton = screen.getByRole('button', { name: '更新' });
      await user.click(submitButton);

      await waitFor(() => {
        expect(mockAlert).toHaveBeenCalledWith('テナント更新に失敗しました');
      });

      // 状態がリセットされ、ボタンが再度有効になる
      await waitFor(() => {
        const resetButton = screen.getByRole('button', { name: '更新' });
        expect(resetButton).not.toBeDisabled();
      });
    });
  });

  describe('バリデーション', () => {
    it('名前が空の場合、送信できないべき', async () => {
      vi.mocked(mockTenantApi.getTenant).mockResolvedValue(mockTenant);

      await renderPage(Promise.resolve({ id: 'test-tenant-id' }));

      await waitFor(() => {
        expect(screen.getByLabelText('テナント名')).toHaveValue('Test Tenant');
      });

      const nameInput = screen.getByLabelText('テナント名');
      expect(nameInput).toBeRequired();
    });

    it('無効なメールアドレスの場合、送信できないべき', async () => {
      vi.mocked(mockTenantApi.getTenant).mockResolvedValue(mockTenant);

      await renderPage(Promise.resolve({ id: 'test-tenant-id' }));

      await waitFor(() => {
        expect(screen.getByDisplayValue('Test Tenant')).toBeInTheDocument();
      });

      const emailInput = screen.getByLabelText('管理者 Email');
      expect(emailInput).toHaveAttribute('type', 'email');
      expect(emailInput).toBeRequired();
    });
  });

  describe('キャンセルボタン', () => {
    it('キャンセルボタンをクリックすると詳細ページに戻るべき', async () => {
      vi.mocked(mockTenantApi.getTenant).mockResolvedValue(mockTenant);

      await renderPage(Promise.resolve({ id: 'test-tenant-id' }));

      await waitFor(() => {
        expect(screen.getByDisplayValue('Test Tenant')).toBeInTheDocument();
      });

      const cancelLink = screen.getByRole('link', { name: 'キャンセル' });
      expect(cancelLink).toHaveAttribute(
        'href',
        '/dashboard/tenants/test-tenant-id'
      );
    });
  });

  describe('フォーム項目', () => {
    it('Tier を変更できるべき', async () => {
      vi.mocked(mockTenantApi.getTenant).mockResolvedValue(mockTenant);

      await renderPage(Promise.resolve({ id: 'test-tenant-id' }));

      const tierSelect = await screen.findByLabelText('Tier');
      expect(tierSelect).toHaveValue('pro');

      fireEvent.change(tierSelect, { target: { value: 'enterprise' } });

      expect(screen.getByLabelText('Tier')).toHaveValue('enterprise');
    });

    it('ステータスを変更できるべき', async () => {
      vi.mocked(mockTenantApi.getTenant).mockResolvedValue(mockTenant);

      await renderPage(Promise.resolve({ id: 'test-tenant-id' }));

      const statusSelect = await screen.findByLabelText('ステータス');
      expect(statusSelect).toHaveValue('active');

      fireEvent.change(statusSelect, { target: { value: 'suspended' } });

      expect(screen.getByLabelText('ステータス')).toHaveValue('suspended');
    });
  });
});
