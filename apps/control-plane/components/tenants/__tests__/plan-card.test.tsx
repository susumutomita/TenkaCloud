import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tenantApi } from '@/lib/api/tenant-api';
import type { Tenant } from '@/types/tenant';
import { PlanCard } from '../plan-card';

vi.mock('@/lib/api/tenant-api', () => ({
  tenantApi: {
    updateTenant: vi.fn(),
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
  tier: 'FREE',
  status: 'ACTIVE',
  region: 'ap-northeast-1',
  isolationModel: 'POOL',
  computeType: 'SERVERLESS',
  provisioningStatus: 'COMPLETED',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
  ...overrides,
});

describe('PlanCard コンポーネント', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('レンダリング', () => {
    it('プランセクションタイトルを表示すべき', () => {
      render(<PlanCard tenant={createMockTenant()} />);
      expect(screen.getByText('プラン')).toBeInTheDocument();
    });

    it('現在のプランを表示すべき', () => {
      render(<PlanCard tenant={createMockTenant({ tier: 'PRO' })} />);
      expect(screen.getByText('現在のプラン')).toBeInTheDocument();
      expect(screen.getByText('Pro')).toBeInTheDocument();
    });

    it('3つのプランオプションを表示すべき', () => {
      render(<PlanCard tenant={createMockTenant()} />);
      expect(screen.getByText('Free')).toBeInTheDocument();
      expect(screen.getByText('Pro')).toBeInTheDocument();
      expect(screen.getByText('Enterprise')).toBeInTheDocument();
    });

    it('各プランの機能制限を表示すべき', () => {
      render(<PlanCard tenant={createMockTenant()} />);
      expect(screen.getByText('10名まで')).toBeInTheDocument();
      expect(screen.getByText('100名まで')).toBeInTheDocument();
      // ENTERPRISE プランは参加者数とバトル数が無制限なので2つ表示される
      expect(screen.getAllByText('無制限')).toHaveLength(2);
    });
  });

  describe('プラン選択ボタン', () => {
    it('FREE プランで他のプランへのアップグレードボタンを表示すべき', () => {
      render(<PlanCard tenant={createMockTenant({ tier: 'FREE' })} />);
      expect(
        screen.getByRole('button', { name: 'Pro にアップグレード' })
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Enterprise にアップグレード' })
      ).toBeInTheDocument();
    });

    it('PRO プランで FREE へのダウングレードボタンを表示すべき', () => {
      render(<PlanCard tenant={createMockTenant({ tier: 'PRO' })} />);
      expect(
        screen.getByRole('button', { name: 'Free にダウングレード' })
      ).toBeInTheDocument();
    });

    it('ENTERPRISE プランで他のプランへのダウングレードボタンを表示すべき', () => {
      render(<PlanCard tenant={createMockTenant({ tier: 'ENTERPRISE' })} />);
      expect(
        screen.getByRole('button', { name: 'Free にダウングレード' })
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Pro にダウングレード' })
      ).toBeInTheDocument();
    });

    it('現在のプランには「現在のプラン」バッジを表示すべき', () => {
      render(<PlanCard tenant={createMockTenant({ tier: 'PRO' })} />);
      const proPlanCard = screen.getByTestId('plan-card-PRO');
      expect(proPlanCard).toHaveTextContent('現在のプラン');
    });
  });

  describe('プラン変更', () => {
    it('アップグレードボタンをクリックで確認ダイアログを表示すべき', async () => {
      const user = userEvent.setup();
      render(<PlanCard tenant={createMockTenant({ tier: 'FREE' })} />);

      await user.click(
        screen.getByRole('button', { name: 'Pro にアップグレード' })
      );

      expect(screen.getByText('プランを変更しますか？')).toBeInTheDocument();
    });

    it('確認ダイアログで変更を確定できるべき', async () => {
      const user = userEvent.setup();
      vi.mocked(tenantApi.updateTenant).mockResolvedValue({
        ...createMockTenant({ tier: 'PRO' }),
      });

      render(<PlanCard tenant={createMockTenant({ tier: 'FREE' })} />);

      await user.click(
        screen.getByRole('button', { name: 'Pro にアップグレード' })
      );
      await user.click(screen.getByRole('button', { name: '変更を確定' }));

      await waitFor(() => {
        expect(tenantApi.updateTenant).toHaveBeenCalledWith(
          '01HJXK5K3VDXK5YPNZBKRT5ABC',
          { tier: 'PRO' }
        );
        expect(mockRefresh).toHaveBeenCalled();
      });
    });

    it('確認ダイアログでキャンセルできるべき', async () => {
      const user = userEvent.setup();
      render(<PlanCard tenant={createMockTenant({ tier: 'FREE' })} />);

      await user.click(
        screen.getByRole('button', { name: 'Pro にアップグレード' })
      );
      await user.click(screen.getByRole('button', { name: 'キャンセル' }));

      expect(
        screen.queryByText('プランを変更しますか？')
      ).not.toBeInTheDocument();
      expect(tenantApi.updateTenant).not.toHaveBeenCalled();
    });

    it('POOL から SILO への変更時に再プロビジョニング警告を表示すべき', async () => {
      const user = userEvent.setup();
      render(<PlanCard tenant={createMockTenant({ tier: 'PRO' })} />);

      await user.click(
        screen.getByRole('button', { name: 'Enterprise にアップグレード' })
      );

      expect(screen.getByText(/再プロビジョニングが必要/)).toBeInTheDocument();
    });

    it('現在のプランのカードをクリックしても何も起きないべき', async () => {
      const user = userEvent.setup();
      render(<PlanCard tenant={createMockTenant({ tier: 'PRO' })} />);

      // PROプランカード内をクリック（ボタンはないのでカード自体を直接操作できない）
      // 代わりに、ボタンがないことを確認する
      const proCard = screen.getByTestId('plan-card-PRO');
      expect(proCard).not.toHaveTextContent('アップグレード');
      expect(proCard).not.toHaveTextContent('ダウングレード');

      // ダイアログが表示されていないことを確認
      expect(
        screen.queryByText('プランを変更しますか？')
      ).not.toBeInTheDocument();
    });

    it('ダウングレード時にダイアログで「ダウングレード」と表示すべき', async () => {
      const user = userEvent.setup();
      render(<PlanCard tenant={createMockTenant({ tier: 'PRO' })} />);

      await user.click(
        screen.getByRole('button', { name: 'Free にダウングレード' })
      );

      expect(
        screen.getByText(/Pro → Free にダウングレード/)
      ).toBeInTheDocument();
    });

    it('アップグレード時にダイアログで「アップグレード」と表示すべき', async () => {
      const user = userEvent.setup();
      render(<PlanCard tenant={createMockTenant({ tier: 'FREE' })} />);

      await user.click(
        screen.getByRole('button', { name: 'Pro にアップグレード' })
      );

      expect(
        screen.getByText(/Free → Pro にアップグレード/)
      ).toBeInTheDocument();
    });
  });

  describe('エラーハンドリング', () => {
    it('プラン変更エラー時にエラーメッセージを表示すべき', async () => {
      const user = userEvent.setup();
      vi.mocked(tenantApi.updateTenant).mockRejectedValue(
        new Error('Update failed')
      );

      render(<PlanCard tenant={createMockTenant({ tier: 'FREE' })} />);

      await user.click(
        screen.getByRole('button', { name: 'Pro にアップグレード' })
      );
      await user.click(screen.getByRole('button', { name: '変更を確定' }));

      await waitFor(() => {
        expect(screen.getByText('Update failed')).toBeInTheDocument();
      });
    });

    it('非 Error オブジェクトの例外時はフォールバックメッセージを表示すべき', async () => {
      const user = userEvent.setup();
      vi.mocked(tenantApi.updateTenant).mockRejectedValue('string error');

      render(<PlanCard tenant={createMockTenant({ tier: 'FREE' })} />);

      await user.click(
        screen.getByRole('button', { name: 'Pro にアップグレード' })
      );
      await user.click(screen.getByRole('button', { name: '変更を確定' }));

      await waitFor(() => {
        expect(
          screen.getByText('プランの変更に失敗しました')
        ).toBeInTheDocument();
      });
    });
  });
});
