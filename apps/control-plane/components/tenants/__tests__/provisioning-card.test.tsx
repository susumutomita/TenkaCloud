import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tenantApi } from '@/lib/api/tenant-api';
import type { Tenant } from '@/types/tenant';
import { ProvisioningCard } from '../provisioning-card';

vi.mock('@/lib/api/tenant-api', () => ({
  tenantApi: {
    triggerProvisioning: vi.fn(),
  },
}));

const mockRefresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({
    refresh: mockRefresh,
  })),
}));

const createMockTenant = (overrides: Partial<Tenant> = {}): Tenant => ({
  id: '01HJXK5K3VDXK5YPNZBKRT5ABC',
  name: 'Test Tenant',
  slug: 'test-tenant',
  adminEmail: 'admin@test.com',
  tier: 'PRO',
  status: 'ACTIVE',
  region: 'ap-northeast-1',
  isolationModel: 'SILO',
  computeType: 'SERVERLESS',
  provisioningStatus: 'PENDING',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
  ...overrides,
});

describe('ProvisioningCard コンポーネント', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('レンダリング', () => {
    it('プロビジョニングセクションタイトルを表示すべき', () => {
      render(<ProvisioningCard tenant={createMockTenant()} />);
      expect(screen.getByText('プロビジョニング')).toBeInTheDocument();
    });

    it('リージョンを表示すべき', () => {
      render(
        <ProvisioningCard
          tenant={createMockTenant({ region: 'ap-northeast-1' })}
        />
      );
      expect(screen.getByText('リージョン')).toBeInTheDocument();
      expect(screen.getByText('ap-northeast-1')).toBeInTheDocument();
    });

    it('分離モデルを表示すべき', () => {
      render(
        <ProvisioningCard
          tenant={createMockTenant({ isolationModel: 'SILO' })}
        />
      );
      expect(screen.getByText('分離モデル')).toBeInTheDocument();
      expect(screen.getByText('SILO')).toBeInTheDocument();
    });

    it('コンピュートタイプを表示すべき', () => {
      render(
        <ProvisioningCard
          tenant={createMockTenant({ computeType: 'SERVERLESS' })}
        />
      );
      expect(screen.getByText('コンピュートタイプ')).toBeInTheDocument();
      expect(screen.getByText('SERVERLESS')).toBeInTheDocument();
    });
  });

  describe('ステータス表示', () => {
    it('PENDING ステータスを表示すべき', () => {
      render(
        <ProvisioningCard
          tenant={createMockTenant({ provisioningStatus: 'PENDING' })}
        />
      );
      expect(screen.getByText('未プロビジョニング')).toBeInTheDocument();
    });

    it('IN_PROGRESS ステータスを表示すべき', () => {
      render(
        <ProvisioningCard
          tenant={createMockTenant({ provisioningStatus: 'IN_PROGRESS' })}
        />
      );
      expect(screen.getByText('プロビジョニング中')).toBeInTheDocument();
    });

    it('COMPLETED ステータスを表示すべき', () => {
      render(
        <ProvisioningCard
          tenant={createMockTenant({ provisioningStatus: 'COMPLETED' })}
        />
      );
      expect(screen.getByText('プロビジョニング完了')).toBeInTheDocument();
    });

    it('FAILED ステータスを表示すべき', () => {
      render(
        <ProvisioningCard
          tenant={createMockTenant({ provisioningStatus: 'FAILED' })}
        />
      );
      expect(screen.getByText('プロビジョニング失敗')).toBeInTheDocument();
    });
  });

  describe('プロビジョニングボタン', () => {
    it('PENDING ステータスでプロビジョニング開始ボタンを表示すべき', () => {
      render(
        <ProvisioningCard
          tenant={createMockTenant({ provisioningStatus: 'PENDING' })}
        />
      );
      expect(
        screen.getByRole('button', { name: 'プロビジョニング開始' })
      ).toBeInTheDocument();
    });

    it('FAILED ステータスで再試行ボタンを表示すべき', () => {
      render(
        <ProvisioningCard
          tenant={createMockTenant({ provisioningStatus: 'FAILED' })}
        />
      );
      expect(
        screen.getByRole('button', { name: '再試行' })
      ).toBeInTheDocument();
    });

    it('IN_PROGRESS ステータスでボタンを表示しないべき', () => {
      render(
        <ProvisioningCard
          tenant={createMockTenant({ provisioningStatus: 'IN_PROGRESS' })}
        />
      );
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });

    it('COMPLETED ステータスでボタンを表示しないべき', () => {
      render(
        <ProvisioningCard
          tenant={createMockTenant({ provisioningStatus: 'COMPLETED' })}
        />
      );
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });
  });

  describe('プロビジョニング実行', () => {
    it('ボタンクリックでプロビジョニングを開始すべき', async () => {
      const user = userEvent.setup();
      vi.mocked(tenantApi.triggerProvisioning).mockResolvedValue({
        success: true,
        message: 'Provisioning started',
        provisioningStatus: 'IN_PROGRESS',
      });

      const tenant = createMockTenant({ provisioningStatus: 'PENDING' });
      render(<ProvisioningCard tenant={tenant} />);

      await user.click(
        screen.getByRole('button', { name: 'プロビジョニング開始' })
      );

      await waitFor(() => {
        expect(tenantApi.triggerProvisioning).toHaveBeenCalledWith(tenant.id);
        expect(mockRefresh).toHaveBeenCalled();
      });
    });

    it('プロビジョニング中はボタンテキストが変わるべき', async () => {
      const user = userEvent.setup();
      vi.mocked(tenantApi.triggerProvisioning).mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 100))
      );

      render(
        <ProvisioningCard
          tenant={createMockTenant({ provisioningStatus: 'PENDING' })}
        />
      );

      await user.click(
        screen.getByRole('button', { name: 'プロビジョニング開始' })
      );

      expect(
        screen.getByRole('button', { name: 'プロビジョニング中...' })
      ).toBeInTheDocument();
    });

    it('エラー時にエラーメッセージを表示すべき', async () => {
      const user = userEvent.setup();
      vi.mocked(tenantApi.triggerProvisioning).mockRejectedValue(
        new Error('Network error')
      );

      render(
        <ProvisioningCard
          tenant={createMockTenant({ provisioningStatus: 'PENDING' })}
        />
      );

      await user.click(
        screen.getByRole('button', { name: 'プロビジョニング開始' })
      );

      await waitFor(() => {
        expect(screen.getByText('Network error')).toBeInTheDocument();
      });
    });

    it('非 Error オブジェクトの例外時はフォールバックメッセージを表示すべき', async () => {
      const user = userEvent.setup();
      vi.mocked(tenantApi.triggerProvisioning).mockRejectedValue(
        'string error'
      );

      render(
        <ProvisioningCard
          tenant={createMockTenant({ provisioningStatus: 'PENDING' })}
        />
      );

      await user.click(
        screen.getByRole('button', { name: 'プロビジョニング開始' })
      );

      await waitFor(() => {
        expect(
          screen.getByText('プロビジョニングに失敗しました')
        ).toBeInTheDocument();
      });
    });
  });
});
