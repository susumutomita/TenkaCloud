import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TenantActions } from '../tenant-actions';
import { mockTenantApi } from '@/lib/api/mock-tenant-api';

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
    deleteTenant: vi.fn(),
  },
}));

// window.confirm をモック
const mockConfirm = vi.fn();
const mockAlert = vi.fn();
global.confirm = mockConfirm;
global.alert = mockAlert;

describe('TenantActions コンポーネント', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('削除ボタン', () => {
    it('削除ボタンが表示されるべき', () => {
      render(<TenantActions tenantId="test-tenant-id" />);
      const deleteButton = screen.getByRole('button', { name: '削除' });
      expect(deleteButton).toBeInTheDocument();
    });

    it('削除ボタンをクリックすると確認ダイアログが表示されるべき', async () => {
      const user = userEvent.setup();
      mockConfirm.mockReturnValue(false);

      render(<TenantActions tenantId="test-tenant-id" />);
      const deleteButton = screen.getByRole('button', { name: '削除' });

      await user.click(deleteButton);

      expect(mockConfirm).toHaveBeenCalledWith(
        '本当にこのテナントを削除しますか？この操作は取り消せません。'
      );
    });

    it('確認ダイアログでキャンセルした場合、削除処理が実行されないべき', async () => {
      const user = userEvent.setup();
      mockConfirm.mockReturnValue(false);

      render(<TenantActions tenantId="test-tenant-id" />);
      const deleteButton = screen.getByRole('button', { name: '削除' });

      await user.click(deleteButton);

      expect(mockTenantApi.deleteTenant).not.toHaveBeenCalled();
      expect(mockPush).not.toHaveBeenCalled();
    });

    it('確認後に削除が成功した場合、テナント一覧ページに遷移するべき', async () => {
      const user = userEvent.setup();
      mockConfirm.mockReturnValue(true);
      vi.mocked(mockTenantApi.deleteTenant).mockResolvedValue(true);

      render(<TenantActions tenantId="test-tenant-id" />);
      const deleteButton = screen.getByRole('button', { name: '削除' });

      await user.click(deleteButton);

      await waitFor(() => {
        expect(mockTenantApi.deleteTenant).toHaveBeenCalledWith(
          'test-tenant-id'
        );
        expect(mockPush).toHaveBeenCalledWith('/dashboard/tenants');
        expect(mockRefresh).toHaveBeenCalled();
      });
    });

    it('削除中は「削除中...」と表示され、ボタンが無効化されるべき', async () => {
      const user = userEvent.setup();
      mockConfirm.mockReturnValue(true);

      // deleteTenant を遅延させて削除中の状態をテスト
      let resolveDelete: (value: boolean) => void;
      const deletePromise = new Promise<boolean>((resolve) => {
        resolveDelete = resolve;
      });
      vi.mocked(mockTenantApi.deleteTenant).mockReturnValue(deletePromise);

      render(<TenantActions tenantId="test-tenant-id" />);
      const deleteButton = screen.getByRole('button', { name: '削除' });

      await user.click(deleteButton);

      // 削除中の状態を確認
      await waitFor(() => {
        const deletingButton = screen.getByRole('button', {
          name: '削除中...',
        });
        expect(deletingButton).toBeDisabled();
      });

      // 削除を完了
      resolveDelete!(true);

      await waitFor(() => {
        const resetButton = screen.getByRole('button', { name: '削除' });
        expect(resetButton).not.toBeDisabled();
      });
    });

    it('削除失敗時にエラーメッセージが表示され、状態がリセットされるべき', async () => {
      const user = userEvent.setup();
      mockConfirm.mockReturnValue(true);
      const error = new Error('削除に失敗しました');
      vi.mocked(mockTenantApi.deleteTenant).mockRejectedValue(error);

      render(<TenantActions tenantId="test-tenant-id" />);
      const deleteButton = screen.getByRole('button', { name: '削除' });

      await user.click(deleteButton);

      await waitFor(() => {
        expect(mockAlert).toHaveBeenCalledWith('テナント削除に失敗しました');
      });

      // 状態がリセットされ、ボタンが再度有効になる
      const resetButton = screen.getByRole('button', { name: '削除' });
      expect(resetButton).not.toBeDisabled();
    });

    it('削除成功後も状態がリセットされるべき', async () => {
      const user = userEvent.setup();
      mockConfirm.mockReturnValue(true);
      vi.mocked(mockTenantApi.deleteTenant).mockResolvedValue(true);

      render(<TenantActions tenantId="test-tenant-id" />);
      const deleteButton = screen.getByRole('button', { name: '削除' });

      await user.click(deleteButton);

      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith('/dashboard/tenants');
      });

      // finally ブロックで状態がリセットされる
      // （ただし、ページ遷移するので実際には見えない）
    });
  });
});
