import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tenantApi } from '@/lib/api/tenant-api';
import { TenantActions } from '../tenant-actions';

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
vi.mock('@/lib/api/tenant-api', () => ({
  tenantApi: {
    deleteTenant: vi.fn(),
  },
}));

// window.alert をモック
const mockAlert = vi.fn();
global.alert = mockAlert;

describe('TenantActions コンポーネント', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('削除ボタンとAlertDialog', () => {
    it('削除ボタンが表示されるべき', () => {
      render(<TenantActions tenantId="test-tenant-id" />);
      const deleteButton = screen.getByRole('button', { name: '削除' });
      expect(deleteButton).toBeInTheDocument();
    });

    it('削除ボタンをクリックすると確認ダイアログが表示されるべき', async () => {
      const user = userEvent.setup();
      render(<TenantActions tenantId="test-tenant-id" />);

      const deleteButton = screen.getByRole('button', { name: '削除' });
      await user.click(deleteButton);

      // AlertDialog の内容が表示される
      expect(screen.getByText('テナントを削除しますか？')).toBeInTheDocument();
      expect(
        screen.getByText(
          'この操作は取り消せません。テナントに関連するすべてのデータが完全に削除されます。'
        )
      ).toBeInTheDocument();
    });

    it('確認ダイアログでキャンセルした場合、削除処理が実行されないべき', async () => {
      const user = userEvent.setup();
      render(<TenantActions tenantId="test-tenant-id" />);

      // ダイアログを開く
      const deleteButton = screen.getByRole('button', { name: '削除' });
      await user.click(deleteButton);

      // キャンセルボタンをクリック
      const cancelButton = screen.getByRole('button', { name: 'キャンセル' });
      await user.click(cancelButton);

      expect(tenantApi.deleteTenant).not.toHaveBeenCalled();
      expect(mockPush).not.toHaveBeenCalled();
    });

    it('確認後に削除が成功した場合、テナント一覧ページに遷移するべき', async () => {
      const user = userEvent.setup();
      vi.mocked(tenantApi.deleteTenant).mockResolvedValue(true);

      render(<TenantActions tenantId="test-tenant-id" />);

      // ダイアログを開く
      const deleteButton = screen.getByRole('button', { name: '削除' });
      await user.click(deleteButton);

      // 削除するボタンをクリック
      const confirmButton = screen.getByRole('button', { name: '削除する' });
      await user.click(confirmButton);

      await waitFor(() => {
        expect(tenantApi.deleteTenant).toHaveBeenCalledWith('test-tenant-id');
        expect(mockPush).toHaveBeenCalledWith('/dashboard/tenants');
        expect(mockRefresh).toHaveBeenCalled();
      });
    });

    it('削除中は「削除中...」と表示され、ボタンが無効化されるべき', async () => {
      const user = userEvent.setup();

      // deleteTenant を遅延させて削除中の状態をテスト
      let resolveDelete: (value: boolean) => void = () => {};
      const deletePromise = new Promise<boolean>((resolve) => {
        resolveDelete = resolve;
      });
      vi.mocked(tenantApi.deleteTenant).mockReturnValue(deletePromise);

      render(<TenantActions tenantId="test-tenant-id" />);

      // ダイアログを開く
      const deleteButton = screen.getByRole('button', { name: '削除' });
      await user.click(deleteButton);

      // 削除するボタンをクリック
      const confirmButton = screen.getByRole('button', { name: '削除する' });
      await user.click(confirmButton);

      // 削除中の状態を確認
      await waitFor(() => {
        const deletingButton = screen.getByRole('button', {
          name: '削除中...',
        });
        expect(deletingButton).toBeDisabled();
      });

      // 削除を完了
      resolveDelete(true);

      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith('/dashboard/tenants');
      });
    });

    it('削除失敗時にエラーメッセージが表示されるべき', async () => {
      const user = userEvent.setup();
      const error = new Error('削除に失敗しました');
      vi.mocked(tenantApi.deleteTenant).mockRejectedValue(error);

      render(<TenantActions tenantId="test-tenant-id" />);

      // ダイアログを開く
      const deleteButton = screen.getByRole('button', { name: '削除' });
      await user.click(deleteButton);

      // 削除するボタンをクリック
      const confirmButton = screen.getByRole('button', { name: '削除する' });
      await user.click(confirmButton);

      await waitFor(() => {
        expect(mockAlert).toHaveBeenCalledWith('テナント削除に失敗しました');
      });
    });

    it('削除中はボタンが無効化されるべき', async () => {
      const user = userEvent.setup();

      // deleteTenant を遅延させて削除中の状態をテスト
      let resolveDelete: (value: boolean) => void = () => {};
      const deletePromise = new Promise<boolean>((resolve) => {
        resolveDelete = resolve;
      });
      vi.mocked(tenantApi.deleteTenant).mockReturnValue(deletePromise);

      render(<TenantActions tenantId="test-tenant-id" />);

      // ダイアログを開く
      const deleteButton = screen.getByRole('button', { name: '削除' });
      await user.click(deleteButton);

      // 削除するボタンをクリック
      const confirmButton = screen.getByRole('button', { name: '削除する' });
      await user.click(confirmButton);

      // 削除中の状態でボタンが無効化されていることを確認
      await waitFor(() => {
        const deletingButton = screen.getByRole('button', {
          name: '削除中...',
        });
        expect(deletingButton).toBeDisabled();
      });

      // 削除を完了
      resolveDelete(true);

      await waitFor(() => {
        expect(mockPush).toHaveBeenCalled();
      });
    });
  });
});
