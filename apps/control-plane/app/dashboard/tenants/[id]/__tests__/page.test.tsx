import { render, screen } from '@testing-library/react';
import { notFound, usePathname } from 'next/navigation';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tenantApi } from '@/lib/api/tenant-api';
import type { Tenant } from '@/types/tenant';
import TenantDetailPage from '../page';

// tenant-api のモック
vi.mock('@/lib/api/tenant-api', () => ({
  tenantApi: {
    getTenant: vi.fn(),
    deleteTenant: vi.fn(),
    triggerProvisioning: vi.fn(),
  },
}));

// next/navigation のモック
// notFound() は実際には例外をスローして実行を停止する
class NotFoundError extends Error {
  constructor() {
    super('NEXT_NOT_FOUND');
  }
}

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new NotFoundError();
  }),
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    refresh: vi.fn(),
  })),
  usePathname: vi.fn(),
}));

const mockTenant: Tenant = {
  id: 'tenant-123',
  name: 'テストテナント',
  slug: 'test-tenant',
  status: 'ACTIVE',
  tier: 'PRO',
  adminEmail: 'admin@example.com',
  region: 'ap-northeast-1',
  isolationModel: 'POOL',
  computeType: 'SERVERLESS',
  provisioningStatus: 'COMPLETED',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-02T00:00:00Z',
};

describe('TenantDetailPage コンポーネント', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(usePathname).mockReturnValue('/dashboard/tenants/tenant-123');
  });

  describe('テナントが存在しない場合', () => {
    it('notFound を呼ぶべき', async () => {
      vi.mocked(tenantApi.getTenant).mockResolvedValue(null);

      await expect(
        TenantDetailPage({ params: Promise.resolve({ id: 'not-found' }) })
      ).rejects.toThrow('NEXT_NOT_FOUND');

      expect(notFound).toHaveBeenCalled();
    });
  });

  describe('テナントが存在する場合', () => {
    beforeEach(() => {
      vi.mocked(tenantApi.getTenant).mockResolvedValue(mockTenant);
    });

    it('テナント名を表示すべき', async () => {
      const Component = await TenantDetailPage({
        params: Promise.resolve({ id: 'tenant-123' }),
      });
      render(Component);
      expect(screen.getByText('テストテナント')).toBeInTheDocument();
    });

    it('テナントIDを表示すべき', async () => {
      const Component = await TenantDetailPage({
        params: Promise.resolve({ id: 'tenant-123' }),
      });
      render(Component);
      expect(screen.getByText('ID: tenant-123')).toBeInTheDocument();
    });

    it('戻るリンクを表示すべき', async () => {
      const Component = await TenantDetailPage({
        params: Promise.resolve({ id: 'tenant-123' }),
      });
      render(Component);
      expect(screen.getByRole('link', { name: '戻る' })).toHaveAttribute(
        'href',
        '/dashboard/tenants'
      );
    });

    it('編集リンクを表示すべき', async () => {
      const Component = await TenantDetailPage({
        params: Promise.resolve({ id: 'tenant-123' }),
      });
      render(Component);
      expect(screen.getByRole('link', { name: '編集' })).toHaveAttribute(
        'href',
        '/dashboard/tenants/tenant-123/edit'
      );
    });

    it('基本情報セクションを表示すべき', async () => {
      const Component = await TenantDetailPage({
        params: Promise.resolve({ id: 'tenant-123' }),
      });
      render(Component);
      expect(screen.getByText('基本情報')).toBeInTheDocument();
    });

    it('テナントステータスを表示すべき', async () => {
      const Component = await TenantDetailPage({
        params: Promise.resolve({ id: 'tenant-123' }),
      });
      render(Component);
      // 基本情報とプロビジョニングの両方にステータスがあるため、複数存在することを確認
      const statusLabels = screen.getAllByText('ステータス');
      expect(statusLabels.length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText('ACTIVE')).toBeInTheDocument();
    });

    it('Tier を表示すべき', async () => {
      const Component = await TenantDetailPage({
        params: Promise.resolve({ id: 'tenant-123' }),
      });
      render(Component);
      expect(screen.getByText('Tier')).toBeInTheDocument();
      expect(screen.getByText('PRO')).toBeInTheDocument();
    });

    it('管理者 Email を表示すべき', async () => {
      const Component = await TenantDetailPage({
        params: Promise.resolve({ id: 'tenant-123' }),
      });
      render(Component);
      expect(screen.getByText('管理者 Email')).toBeInTheDocument();
      expect(screen.getByText('admin@example.com')).toBeInTheDocument();
    });

    it('削除ボタンを表示すべき', async () => {
      const Component = await TenantDetailPage({
        params: Promise.resolve({ id: 'tenant-123' }),
      });
      render(Component);
      expect(screen.getByRole('button', { name: '削除' })).toBeInTheDocument();
    });

    it('Slug を表示すべき', async () => {
      const Component = await TenantDetailPage({
        params: Promise.resolve({ id: 'tenant-123' }),
      });
      render(Component);
      expect(screen.getByText('Slug')).toBeInTheDocument();
      expect(screen.getByText('test-tenant')).toBeInTheDocument();
    });

    it('プロビジョニングセクションを表示すべき', async () => {
      const Component = await TenantDetailPage({
        params: Promise.resolve({ id: 'tenant-123' }),
      });
      render(Component);
      expect(screen.getByText('プロビジョニング')).toBeInTheDocument();
    });

    it('リージョンを表示すべき', async () => {
      const Component = await TenantDetailPage({
        params: Promise.resolve({ id: 'tenant-123' }),
      });
      render(Component);
      expect(screen.getByText('リージョン')).toBeInTheDocument();
      expect(screen.getByText('ap-northeast-1')).toBeInTheDocument();
    });

    it('分離モデルを表示すべき', async () => {
      const Component = await TenantDetailPage({
        params: Promise.resolve({ id: 'tenant-123' }),
      });
      render(Component);
      expect(screen.getByText('分離モデル')).toBeInTheDocument();
      expect(screen.getByText('POOL')).toBeInTheDocument();
    });

    it('コンピュートタイプを表示すべき', async () => {
      const Component = await TenantDetailPage({
        params: Promise.resolve({ id: 'tenant-123' }),
      });
      render(Component);
      expect(screen.getByText('コンピュートタイプ')).toBeInTheDocument();
      expect(screen.getByText('SERVERLESS')).toBeInTheDocument();
    });
  });

  describe('ステータスに応じたスタイル', () => {
    it('ACTIVE ステータスは緑色のバッジを表示すべき', async () => {
      vi.mocked(tenantApi.getTenant).mockResolvedValue({
        ...mockTenant,
        status: 'ACTIVE',
      });
      const Component = await TenantDetailPage({
        params: Promise.resolve({ id: 'tenant-123' }),
      });
      render(Component);
      const badge = screen.getByText('ACTIVE');
      expect(badge).toHaveClass('bg-green-100');
    });

    it('SUSPENDED ステータスは黄色のバッジを表示すべき', async () => {
      vi.mocked(tenantApi.getTenant).mockResolvedValue({
        ...mockTenant,
        status: 'SUSPENDED',
      });
      const Component = await TenantDetailPage({
        params: Promise.resolve({ id: 'tenant-123' }),
      });
      render(Component);
      const badge = screen.getByText('SUSPENDED');
      expect(badge).toHaveClass('bg-yellow-100');
    });

    it('ARCHIVED ステータスは赤色のバッジを表示すべき', async () => {
      vi.mocked(tenantApi.getTenant).mockResolvedValue({
        ...mockTenant,
        status: 'ARCHIVED',
      });
      const Component = await TenantDetailPage({
        params: Promise.resolve({ id: 'tenant-123' }),
      });
      render(Component);
      const badge = screen.getByText('ARCHIVED');
      expect(badge).toHaveClass('bg-red-100');
    });
  });
});
