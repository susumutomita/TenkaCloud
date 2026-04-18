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
        />,
      );
      expect(screen.getByText('リージョン')).toBeInTheDocument();
      expect(screen.getByText('ap-northeast-1')).toBeInTheDocument();
    });

    it('分離モデルを表示すべき', () => {
      render(
        <ProvisioningCard
          tenant={createMockTenant({ isolationModel: 'SILO' })}
        />,
      );
      expect(screen.getByText('分離モデル')).toBeInTheDocument();
      expect(screen.getByText('SILO')).toBeInTheDocument();
    });

    it('コンピュートタイプを表示すべき', () => {
      render(
        <ProvisioningCard
          tenant={createMockTenant({ computeType: 'SERVERLESS' })}
        />,
      );
      expect(screen.getByText('コンピュートタイプ')).toBeInTheDocument();
      expect(screen.getByText('SERVERLESS')).toBeInTheDocument();
    });

    it('Application Plane の状態を表示すべき', () => {
      render(<ProvisioningCard tenant={createMockTenant()} />);
      expect(screen.getByText('Application Plane')).toBeInTheDocument();
      expect(screen.getByText('未デプロイ')).toBeInTheDocument();
    });

    it('作成済みリソースを表示すべき', () => {
      render(
        <ProvisioningCard
          tenant={createMockTenant({
            provisionedResources: {
              s3Prefix: 'tenants/test-tenant/',
              iamRoleArn: 'arn:aws:iam::000000000000:role/test-tenant',
            },
          })}
        />,
      );
      expect(screen.getByText('作成済みリソース')).toBeInTheDocument();
      expect(screen.getByText('tenants/test-tenant/')).toBeInTheDocument();
      expect(
        screen.getByText('arn:aws:iam::000000000000:role/test-tenant'),
      ).toBeInTheDocument();
    });

    it('デプロイ済みの場合は未デプロイ警告を表示しないべき', () => {
      render(
        <ProvisioningCard
          tenant={createMockTenant({
            applicationDeploymentStatus: 'DEPLOYED',
          })}
        />,
      );
      expect(screen.queryByText('未デプロイ')).not.toBeInTheDocument();
      expect(
        screen.queryByText(/Application Plane bundle はまだ配備されていません/),
      ).not.toBeInTheDocument();
    });

    it('デプロイ済みで applicationPlaneEndpoint がある場合はリンクを表示すべき', () => {
      render(
        <ProvisioningCard
          tenant={createMockTenant({
            applicationDeploymentStatus: 'DEPLOYED',
            applicationPlaneEndpoint:
              'http://localhost:13001?tenant=test-tenant',
          })}
        />,
      );
      const link = screen.getByRole('link', {
        name: 'http://localhost:13001?tenant=test-tenant',
      });
      expect(link).toBeInTheDocument();
      expect(link).toHaveAttribute(
        'href',
        'http://localhost:13001?tenant=test-tenant',
      );
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    });

    it('安全でない URL スキームの applicationPlaneEndpoint はリンクではなくテキストで表示すべき', () => {
      render(
        <ProvisioningCard
          tenant={createMockTenant({
            applicationDeploymentStatus: 'DEPLOYED',
            applicationPlaneEndpoint: 'javascript:alert(1)',
          })}
        />,
      );
      expect(
        screen.queryByRole('link', { name: 'javascript:alert(1)' }),
      ).not.toBeInTheDocument();
      expect(screen.getByText('javascript:alert(1)')).toBeInTheDocument();
    });

    it('未デプロイ状態では applicationPlaneEndpoint リンクを表示しないべき', () => {
      render(
        <ProvisioningCard
          tenant={createMockTenant({
            applicationDeploymentStatus: 'NOT_DEPLOYED',
            applicationPlaneEndpoint:
              'http://localhost:13001?tenant=test-tenant',
          })}
        />,
      );
      expect(
        screen.queryByRole('link', {
          name: 'http://localhost:13001?tenant=test-tenant',
        }),
      ).not.toBeInTheDocument();
    });

    it('その他の作成済みリソースとエラーを表示すべき', () => {
      render(
        <ProvisioningCard
          tenant={createMockTenant({
            applicationDeploymentStatus: 'FAILED',
            provisionedResources: {
              s3Bucket: 'tenant-bucket',
              cloudwatchLogGroup: '/tenkacloud/tenants/test-tenant',
              auth0OrganizationId: 'org_test_tenant',
            },
            provisioningError: 'tenant deployment failed',
          })}
        />,
      );
      expect(screen.getByText('tenant-bucket')).toBeInTheDocument();
      expect(
        screen.getByText('/tenkacloud/tenants/test-tenant'),
      ).toBeInTheDocument();
      expect(screen.getByText('org_test_tenant')).toBeInTheDocument();
      expect(screen.getByText('tenant deployment failed')).toBeInTheDocument();
    });
  });

  describe('ステータス表示', () => {
    it('PENDING ステータスを表示すべき', () => {
      render(
        <ProvisioningCard
          tenant={createMockTenant({ provisioningStatus: 'PENDING' })}
        />,
      );
      expect(screen.getByText('未プロビジョニング')).toBeInTheDocument();
    });

    it('IN_PROGRESS ステータスを表示すべき', () => {
      render(
        <ProvisioningCard
          tenant={createMockTenant({ provisioningStatus: 'IN_PROGRESS' })}
        />,
      );
      expect(screen.getByText('プロビジョニング中')).toBeInTheDocument();
    });

    it('COMPLETED ステータスを表示すべき', () => {
      render(
        <ProvisioningCard
          tenant={createMockTenant({ provisioningStatus: 'COMPLETED' })}
        />,
      );
      expect(screen.getByText('プロビジョニング完了')).toBeInTheDocument();
    });

    it('FAILED ステータスを表示すべき', () => {
      render(
        <ProvisioningCard
          tenant={createMockTenant({ provisioningStatus: 'FAILED' })}
        />,
      );
      expect(screen.getByText('プロビジョニング失敗')).toBeInTheDocument();
    });
  });

  describe('プロビジョニングボタン', () => {
    it('PENDING ステータスでプロビジョニング開始ボタンを表示すべき', () => {
      render(
        <ProvisioningCard
          tenant={createMockTenant({ provisioningStatus: 'PENDING' })}
        />,
      );
      expect(
        screen.getByRole('button', { name: 'プロビジョニング開始' }),
      ).toBeInTheDocument();
    });

    it('FAILED ステータスで再試行ボタンを表示すべき', () => {
      render(
        <ProvisioningCard
          tenant={createMockTenant({ provisioningStatus: 'FAILED' })}
        />,
      );
      expect(
        screen.getByRole('button', { name: '再試行' }),
      ).toBeInTheDocument();
    });

    it('IN_PROGRESS ステータスでボタンを表示しないべき', () => {
      render(
        <ProvisioningCard
          tenant={createMockTenant({ provisioningStatus: 'IN_PROGRESS' })}
        />,
      );
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });

    it('COMPLETED ステータスでボタンを表示しないべき', () => {
      render(
        <ProvisioningCard
          tenant={createMockTenant({ provisioningStatus: 'COMPLETED' })}
        />,
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
        screen.getByRole('button', { name: 'プロビジョニング開始' }),
      );

      await waitFor(() => {
        expect(tenantApi.triggerProvisioning).toHaveBeenCalledWith(tenant.id);
        expect(mockRefresh).toHaveBeenCalled();
      });
    });

    it('プロビジョニング中はボタンテキストが変わるべき', async () => {
      const user = userEvent.setup();
      vi.mocked(tenantApi.triggerProvisioning).mockImplementation(
        () => new Promise(() => {}), // 解決しないPromiseでローディング状態を維持
      );

      render(
        <ProvisioningCard
          tenant={createMockTenant({ provisioningStatus: 'PENDING' })}
        />,
      );

      await user.click(
        screen.getByRole('button', { name: 'プロビジョニング開始' }),
      );

      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: 'プロビジョニング中...' }),
        ).toBeInTheDocument();
      });
    });

    it('エラー時にエラーメッセージを表示すべき', async () => {
      const user = userEvent.setup();
      vi.mocked(tenantApi.triggerProvisioning).mockRejectedValue(
        new Error('Network error'),
      );

      render(
        <ProvisioningCard
          tenant={createMockTenant({ provisioningStatus: 'PENDING' })}
        />,
      );

      await user.click(
        screen.getByRole('button', { name: 'プロビジョニング開始' }),
      );

      await waitFor(() => {
        expect(screen.getByText('Network error')).toBeInTheDocument();
      });
    });

    it('非 Error オブジェクトの例外時はフォールバックメッセージを表示すべき', async () => {
      const user = userEvent.setup();
      vi.mocked(tenantApi.triggerProvisioning).mockRejectedValue(
        'string error',
      );

      render(
        <ProvisioningCard
          tenant={createMockTenant({ provisioningStatus: 'PENDING' })}
        />,
      );

      await user.click(
        screen.getByRole('button', { name: 'プロビジョニング開始' }),
      );

      await waitFor(() => {
        expect(
          screen.getByText('プロビジョニングに失敗しました'),
        ).toBeInTheDocument();
      });
    });
  });
});
