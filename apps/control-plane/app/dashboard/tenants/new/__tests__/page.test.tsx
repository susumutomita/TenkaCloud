import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tenantApi } from '@/lib/api/tenant-api';
import NewTenantPage from '../page';

// tenant-api のモック
vi.mock('@/lib/api/tenant-api', () => ({
  tenantApi: {
    createTenant: vi.fn(),
  },
}));

// next/navigation のモック
const mockPush = vi.fn();
const mockRefresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({
    push: mockPush,
    refresh: mockRefresh,
  })),
}));

describe('NewTenantPage コンポーネント', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('レンダリング', () => {
    it('タイトルを表示すべき', () => {
      render(<NewTenantPage />);
      expect(screen.getByText('新規テナント作成')).toBeInTheDocument();
    });

    it('テナント情報セクションを表示すべき', () => {
      render(<NewTenantPage />);
      expect(screen.getByText('テナント情報')).toBeInTheDocument();
      expect(
        screen.getByText('新しいテナントを作成します。')
      ).toBeInTheDocument();
    });

    it('テナント名入力フィールドを表示すべき', () => {
      render(<NewTenantPage />);
      expect(screen.getByLabelText('テナント名')).toBeInTheDocument();
    });

    it('管理者 Email 入力フィールドを表示すべき', () => {
      render(<NewTenantPage />);
      expect(screen.getByLabelText('管理者 Email')).toBeInTheDocument();
    });

    it('スラッグ入力フィールドを表示すべき', () => {
      render(<NewTenantPage />);
      expect(
        screen.getByLabelText('スラッグ（URL識別子）')
      ).toBeInTheDocument();
    });

    it('Tier 選択フィールドを表示すべき', () => {
      render(<NewTenantPage />);
      expect(screen.getByLabelText('Tier')).toBeInTheDocument();
    });

    it('作成ボタンを表示すべき', () => {
      render(<NewTenantPage />);
      expect(screen.getByRole('button', { name: '作成' })).toBeInTheDocument();
    });

    it('キャンセルリンクを表示すべき', () => {
      render(<NewTenantPage />);
      expect(screen.getByRole('link', { name: 'キャンセル' })).toHaveAttribute(
        'href',
        '/dashboard/tenants'
      );
    });
  });

  describe('フォーム入力', () => {
    it('テナント名を入力できるべき', async () => {
      const user = userEvent.setup();
      render(<NewTenantPage />);

      const input = screen.getByLabelText('テナント名');
      await user.type(input, '株式会社テスト');
      expect(input).toHaveValue('株式会社テスト');
    });

    it('管理者 Email を入力できるべき', async () => {
      const user = userEvent.setup();
      render(<NewTenantPage />);

      const input = screen.getByLabelText('管理者 Email');
      await user.type(input, 'admin@test.com');
      expect(input).toHaveValue('admin@test.com');
    });

    it('スラッグを入力できるべき', async () => {
      const user = userEvent.setup();
      render(<NewTenantPage />);

      const input = screen.getByLabelText('スラッグ（URL識別子）');
      await user.type(input, 'test-tenant');
      expect(input).toHaveValue('test-tenant');
    });

    it('テナント名からスラッグが自動生成されるべき', async () => {
      const user = userEvent.setup();
      render(<NewTenantPage />);

      const nameInput = screen.getByLabelText('テナント名');
      const slugInput = screen.getByLabelText('スラッグ（URL識別子）');

      await user.type(nameInput, 'Test Company');
      expect(slugInput).toHaveValue('test-company');
    });

    it('Tier を選択できるべき', async () => {
      const user = userEvent.setup();
      render(<NewTenantPage />);

      const select = screen.getByLabelText('Tier');
      await user.selectOptions(select, 'PRO');
      expect(select).toHaveValue('PRO');
    });

    it('すべての Tier オプションが存在すべき', () => {
      render(<NewTenantPage />);
      expect(screen.getByRole('option', { name: 'Free' })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: 'Pro' })).toBeInTheDocument();
      expect(
        screen.getByRole('option', { name: 'Enterprise' })
      ).toBeInTheDocument();
    });
  });

  describe('フォーム送信', () => {
    it('フォーム送信時に createTenant が呼ばれるべき', async () => {
      const user = userEvent.setup();
      vi.mocked(tenantApi.createTenant).mockResolvedValue({
        id: '1',
        name: 'Test Company',
        slug: 'test-company',
        status: 'ACTIVE',
        tier: 'FREE',
        adminEmail: 'admin@test.com',
        region: 'ap-northeast-1',
        isolationModel: 'POOL',
        computeType: 'SERVERLESS',
        provisioningStatus: 'PENDING',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      });

      render(<NewTenantPage />);

      await user.type(screen.getByLabelText('テナント名'), 'Test Company');
      await user.type(screen.getByLabelText('管理者 Email'), 'admin@test.com');
      await user.click(screen.getByRole('button', { name: '作成' }));

      await waitFor(() => {
        expect(tenantApi.createTenant).toHaveBeenCalledWith({
          name: 'Test Company',
          slug: 'test-company',
          adminEmail: 'admin@test.com',
          tier: 'FREE',
        });
      });
    });

    it('作成成功後にテナント一覧へリダイレクトすべき', async () => {
      const user = userEvent.setup();
      vi.mocked(tenantApi.createTenant).mockResolvedValue({
        id: '1',
        name: 'Test Company',
        slug: 'test-company',
        status: 'ACTIVE',
        tier: 'FREE',
        adminEmail: 'admin@test.com',
        region: 'ap-northeast-1',
        isolationModel: 'POOL',
        computeType: 'SERVERLESS',
        provisioningStatus: 'PENDING',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      });

      render(<NewTenantPage />);

      await user.type(screen.getByLabelText('テナント名'), 'Test Company');
      await user.type(screen.getByLabelText('管理者 Email'), 'admin@test.com');
      await user.click(screen.getByRole('button', { name: '作成' }));

      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith('/dashboard/tenants');
        expect(mockRefresh).toHaveBeenCalled();
      });
    });

    it('作成中はボタンテキストが変わるべき', async () => {
      const user = userEvent.setup();
      vi.mocked(tenantApi.createTenant).mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 100))
      );

      render(<NewTenantPage />);

      await user.type(screen.getByLabelText('テナント名'), 'test-tenant');
      await user.type(
        screen.getByLabelText('スラッグ（URL識別子）'),
        'test-tenant'
      );
      await user.type(screen.getByLabelText('管理者 Email'), 'test@test.com');
      await user.click(screen.getByRole('button', { name: '作成' }));

      expect(
        screen.getByRole('button', { name: '作成中...' })
      ).toBeInTheDocument();
    });

    it('作成中はボタンが無効になるべき', async () => {
      const user = userEvent.setup();
      vi.mocked(tenantApi.createTenant).mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 100))
      );

      render(<NewTenantPage />);

      await user.type(screen.getByLabelText('テナント名'), 'test-tenant');
      await user.type(
        screen.getByLabelText('スラッグ（URL識別子）'),
        'test-tenant'
      );
      await user.type(screen.getByLabelText('管理者 Email'), 'test@test.com');
      await user.click(screen.getByRole('button', { name: '作成' }));

      expect(screen.getByRole('button', { name: '作成中...' })).toBeDisabled();
    });

    it('作成失敗時にアラートを表示すべき', async () => {
      const user = userEvent.setup();
      const alertMock = vi.spyOn(window, 'alert').mockImplementation(() => {});
      vi.mocked(tenantApi.createTenant).mockRejectedValue(
        new Error('API Error')
      );

      render(<NewTenantPage />);

      await user.type(screen.getByLabelText('テナント名'), 'test-tenant');
      await user.type(
        screen.getByLabelText('スラッグ（URL識別子）'),
        'test-tenant'
      );
      await user.type(screen.getByLabelText('管理者 Email'), 'test@test.com');
      await user.click(screen.getByRole('button', { name: '作成' }));

      await waitFor(() => {
        expect(alertMock).toHaveBeenCalledWith('テナント作成に失敗しました');
      });

      alertMock.mockRestore();
    });
  });
});
