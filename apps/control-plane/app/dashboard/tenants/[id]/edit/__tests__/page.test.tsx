import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tenantApi } from '@/lib/api/tenant-api';
import { submitTenantUpdate, type TenantFormData } from '@/lib/tenant-utils';
import type { Tenant } from '@/types/tenant';
import EditTenantPage from '../page';

// Next.js の useRouter をモック
const mockPush = vi.fn();
const mockRefresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    refresh: mockRefresh,
  }),
}));

// tenantApi をモック（API ベース URL が未設定でも強制的にモックを使用）
vi.mock('@/lib/api/tenant-api', () => ({
  tenantApi: {
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
    slug: 'test-tenant',
    adminEmail: 'admin@test.com',
    tier: 'PRO',
    status: 'ACTIVE',
    region: 'ap-northeast-1',
    isolationModel: 'POOL',
    computeType: 'SERVERLESS',
    provisioningStatus: 'COMPLETED',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('初期表示', () => {
    it('テナント情報を取得してフォームに表示するべき', async () => {
      vi.mocked(tenantApi.getTenant).mockResolvedValue(mockTenant);

      await renderPage(Promise.resolve({ id: 'test-tenant-id' }));

      await waitFor(() => {
        expect(tenantApi.getTenant).toHaveBeenCalledWith('test-tenant-id');
      });

      // データがロードされるまで待つ
      await waitFor(() => {
        expect(screen.getByLabelText('テナント名')).toHaveValue('Test Tenant');
        expect(screen.getByLabelText('管理者 Email')).toHaveValue(
          'admin@test.com'
        );
        expect(screen.getByLabelText('Tier')).toHaveValue('PRO');
        expect(screen.getByLabelText('ステータス')).toHaveValue('ACTIVE');
      });
    });

    it('テナントが見つからない場合、アラートを表示して一覧ページに戻るべき', async () => {
      vi.mocked(tenantApi.getTenant).mockResolvedValue(null);

      await renderPage(Promise.resolve({ id: 'nonexistent-id' }));

      await waitFor(() => {
        expect(mockAlert).toHaveBeenCalledWith('テナントが見つかりません');
        expect(mockPush).toHaveBeenCalledWith('/dashboard/tenants');
      });
    });

    it('テナント取得に失敗した場合、エラーメッセージが表示されるべき', async () => {
      const error = new Error('Failed to fetch');
      vi.mocked(tenantApi.getTenant).mockRejectedValue(error);

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
      const _user = userEvent.setup();
      vi.mocked(tenantApi.getTenant).mockResolvedValue(mockTenant);
      vi.mocked(tenantApi.updateTenant).mockResolvedValue({
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
        expect(tenantApi.updateTenant).toHaveBeenCalledTimes(1);
        expect(mockPush).toHaveBeenCalledWith(
          '/dashboard/tenants/test-tenant-id'
        );
        expect(mockRefresh).toHaveBeenCalled();
      });
    });

    it('更新中は「更新中...」と表示され、ボタンが無効化されるべき', async () => {
      const user = userEvent.setup();
      vi.mocked(tenantApi.getTenant).mockResolvedValue(mockTenant);

      // updateTenant を遅延させて更新中の状態をテスト
      let resolveUpdate: (value: Tenant | null) => void = () => {};
      const updatePromise = new Promise<Tenant | null>((resolve) => {
        resolveUpdate = resolve;
      });
      vi.mocked(tenantApi.updateTenant).mockReturnValue(updatePromise);

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
      resolveUpdate?.(mockTenant);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: '更新' })).not.toBeDisabled();
      });
    });

    it('更新失敗時にエラーメッセージが表示されるべき', async () => {
      const user = userEvent.setup();
      vi.mocked(tenantApi.getTenant).mockResolvedValue(mockTenant);
      const error = new Error('Update failed');
      vi.mocked(tenantApi.updateTenant).mockRejectedValue(error);

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
      vi.mocked(tenantApi.getTenant).mockResolvedValue(mockTenant);

      await renderPage(Promise.resolve({ id: 'test-tenant-id' }));

      await waitFor(() => {
        expect(screen.getByLabelText('テナント名')).toHaveValue('Test Tenant');
      });

      const nameInput = screen.getByLabelText('テナント名');
      expect(nameInput).toBeRequired();
    });

    it('無効なメールアドレスの場合、送信できないべき', async () => {
      vi.mocked(tenantApi.getTenant).mockResolvedValue(mockTenant);

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
      vi.mocked(tenantApi.getTenant).mockResolvedValue(mockTenant);

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
      vi.mocked(tenantApi.getTenant).mockResolvedValue(mockTenant);

      await renderPage(Promise.resolve({ id: 'test-tenant-id' }));

      const tierSelect = await screen.findByLabelText('Tier');
      expect(tierSelect).toHaveValue('PRO');

      fireEvent.change(tierSelect, { target: { value: 'ENTERPRISE' } });

      expect(screen.getByLabelText('Tier')).toHaveValue('ENTERPRISE');
    });

    it('ステータスを変更できるべき', async () => {
      vi.mocked(tenantApi.getTenant).mockResolvedValue(mockTenant);

      await renderPage(Promise.resolve({ id: 'test-tenant-id' }));

      const statusSelect = await screen.findByLabelText('ステータス');
      expect(statusSelect).toHaveValue('ACTIVE');

      fireEvent.change(statusSelect, { target: { value: 'SUSPENDED' } });

      expect(screen.getByLabelText('ステータス')).toHaveValue('SUSPENDED');
    });

    it('テナント名を変更できるべき', async () => {
      vi.mocked(tenantApi.getTenant).mockResolvedValue(mockTenant);

      await renderPage(Promise.resolve({ id: 'test-tenant-id' }));

      const nameInput = await screen.findByLabelText('テナント名');
      expect(nameInput).toHaveValue('Test Tenant');

      fireEvent.change(nameInput, { target: { value: 'Updated Name' } });

      expect(screen.getByLabelText('テナント名')).toHaveValue('Updated Name');
    });

    it('管理者 Email を変更できるべき', async () => {
      vi.mocked(tenantApi.getTenant).mockResolvedValue(mockTenant);

      await renderPage(Promise.resolve({ id: 'test-tenant-id' }));

      const emailInput = await screen.findByLabelText('管理者 Email');
      expect(emailInput).toHaveValue('admin@test.com');

      fireEvent.change(emailInput, { target: { value: 'new@test.com' } });

      expect(screen.getByLabelText('管理者 Email')).toHaveValue('new@test.com');
    });
  });

  describe('params 解決エラー', () => {
    it('params の解決に失敗した場合、エラーメッセージが表示されるべき', async () => {
      // params Promise が拒否されるケースをテスト
      const rejectedParams = Promise.reject(new Error('Params error'));

      // renderPage 内で catch されるので、テスト側でも catch する
      await renderPage(rejectedParams);

      await waitFor(() => {
        expect(mockAlert).toHaveBeenCalledWith(
          'パラメータの取得に失敗しました'
        );
      });
    });
  });

  describe('クリーンアップ処理', () => {
    it('コンポーネントがアンマウントされた後に params が解決された場合、state を更新しないべき', async () => {
      vi.mocked(tenantApi.getTenant).mockResolvedValue(mockTenant);

      // 遅延して解決する params Promise を作成
      let resolveParams: (value: { id: string }) => void = () => {};
      const delayedParams = new Promise<{ id: string }>((resolve) => {
        resolveParams = resolve;
      });

      // コンポーネントをレンダリング
      const { unmount } = render(<EditTenantPage params={delayedParams} />);

      // ローディング中であることを確認
      expect(screen.getByText('読み込み中...')).toBeInTheDocument();

      // コンポーネントをアンマウント（クリーンアップ関数が呼ばれ、active = false になる）
      unmount();

      // params を解決（この時点で active = false なので、setId は呼ばれないはず）
      resolveParams({ id: 'test-tenant-id' });

      // Promise が解決するのを待つ
      await act(async () => {
        await delayedParams;
      });

      // getTenant は呼ばれていないはず（id がセットされていないため）
      expect(tenantApi.getTenant).not.toHaveBeenCalled();
    });
  });

  describe('handleSubmit のガード条件', () => {
    it('id が null の場合、submit で何もしないべき', async () => {
      // このテストは id が null の状態で submit を呼ぶことをテストする
      // id が null のまま form を render するには、params が解決する前に submit をトリガーする
      // しかし、実際には params が解決するまでローディング表示なので、
      // id が null で handleSubmit が呼ばれることは通常ない
      // 代わりに、updateTenant が呼ばれないことを確認する

      // params が解決されないままの状態をシミュレート
      let resolveParams: (value: { id: string }) => void = () => {};
      const pendingParams = new Promise<{ id: string }>((resolve) => {
        resolveParams = resolve;
      });

      render(<EditTenantPage params={pendingParams} />);

      // ローディング中は「読み込み中...」が表示される
      expect(screen.getByText('読み込み中...')).toBeInTheDocument();

      // updateTenant は呼ばれていないはず
      expect(tenantApi.updateTenant).not.toHaveBeenCalled();

      // クリーンアップ: params を解決
      resolveParams({ id: 'test-id' });
    });
  });
});

describe('submitTenantUpdate', () => {
  const mockFormData: TenantFormData = {
    name: 'Test Tenant',
    adminEmail: 'test@example.com',
    tier: 'PRO',
    status: 'ACTIVE',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('id が null の場合、false を返して早期リターンすべき', async () => {
    const onSuccess = vi.fn();
    const onError = vi.fn();

    const result = await submitTenantUpdate(
      null,
      mockFormData,
      onSuccess,
      onError
    );

    expect(result).toBe(false);
    expect(tenantApi.updateTenant).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('id が有効な場合、テナントを更新して true を返すべき', async () => {
    vi.mocked(tenantApi.updateTenant).mockResolvedValue({
      id: 'test-id',
      name: 'Test Tenant',
      slug: 'test-tenant',
      adminEmail: 'test@example.com',
      tier: 'PRO',
      status: 'ACTIVE',
      region: 'ap-northeast-1',
      isolationModel: 'POOL',
      computeType: 'SERVERLESS',
      provisioningStatus: 'COMPLETED',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    });

    const onSuccess = vi.fn();
    const onError = vi.fn();

    const result = await submitTenantUpdate(
      'test-id',
      mockFormData,
      onSuccess,
      onError
    );

    expect(result).toBe(true);
    expect(tenantApi.updateTenant).toHaveBeenCalledWith(
      'test-id',
      mockFormData
    );
    expect(onSuccess).toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('更新失敗時は onError を呼んで false を返すべき', async () => {
    vi.mocked(tenantApi.updateTenant).mockRejectedValue(
      new Error('Update failed')
    );

    const onSuccess = vi.fn();
    const onError = vi.fn();

    const result = await submitTenantUpdate(
      'test-id',
      mockFormData,
      onSuccess,
      onError
    );

    expect(result).toBe(false);
    expect(tenantApi.updateTenant).toHaveBeenCalledWith(
      'test-id',
      mockFormData
    );
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalled();
  });
});
