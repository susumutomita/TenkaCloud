import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Tenant } from '@/types/tenant';
import {
  defaultCopyToClipboard,
  getApplicationPlaneUrl,
  TenantAccessCard,
} from '../tenant-access-card';

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

describe('TenantAccessCard コンポーネント', () => {
  describe('レンダリング', () => {
    it('セクションタイトルを表示すべき', () => {
      render(<TenantAccessCard tenant={createMockTenant()} />);
      expect(screen.getByText('テナント管理画面')).toBeInTheDocument();
    });

    it('説明文を表示すべき', () => {
      render(<TenantAccessCard tenant={createMockTenant()} />);
      expect(
        screen.getByText('このテナントの Application Plane にアクセスします')
      ).toBeInTheDocument();
    });

    it('テナントの Application Plane URL を表示すべき', () => {
      render(<TenantAccessCard tenant={createMockTenant({ slug: 'acme' })} />);
      expect(screen.getByText('https://acme.tenka.cloud')).toBeInTheDocument();
    });

    it('管理画面を開くボタンを表示すべき', () => {
      render(<TenantAccessCard tenant={createMockTenant()} />);
      expect(
        screen.getByRole('link', { name: '管理画面を開く' })
      ).toBeInTheDocument();
    });

    it('URLをコピーボタンを表示すべき', () => {
      render(<TenantAccessCard tenant={createMockTenant()} />);
      expect(
        screen.getByRole('button', { name: 'URLをコピー' })
      ).toBeInTheDocument();
    });
  });

  describe('管理画面を開くリンク', () => {
    it('正しい URL への外部リンクを持つべき', () => {
      render(
        <TenantAccessCard tenant={createMockTenant({ slug: 'my-tenant' })} />
      );
      const link = screen.getByRole('link', { name: '管理画面を開く' });
      expect(link).toHaveAttribute('href', 'https://my-tenant.tenka.cloud');
    });

    it('新しいタブで開くべき', () => {
      render(<TenantAccessCard tenant={createMockTenant()} />);
      const link = screen.getByRole('link', { name: '管理画面を開く' });
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    });
  });

  describe('ヘルパー関数', () => {
    it('getApplicationPlaneUrl が正しい URL を生成すべき', () => {
      expect(getApplicationPlaneUrl('test-tenant')).toBe(
        'https://test-tenant.tenka.cloud'
      );
      expect(getApplicationPlaneUrl('acme')).toBe('https://acme.tenka.cloud');
    });

    it('defaultCopyToClipboard が navigator.clipboard.writeText を呼ぶべき', async () => {
      const mockWriteText = vi.fn().mockResolvedValue(undefined);

      // jsdom では navigator.clipboard が未定義なので設定する
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: mockWriteText },
        writable: true,
        configurable: true,
      });

      await defaultCopyToClipboard('https://test.tenka.cloud');

      expect(mockWriteText).toHaveBeenCalledWith('https://test.tenka.cloud');
    });
  });

  describe('URLコピー機能', () => {
    it('デフォルトでnavigator.clipboardを使用してコピーすべき', async () => {
      const user = userEvent.setup();
      const mockWriteText = vi.fn().mockResolvedValue(undefined);

      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: mockWriteText },
        writable: true,
        configurable: true,
      });

      render(
        <TenantAccessCard tenant={createMockTenant({ slug: 'default-copy' })} />
      );

      await user.click(screen.getByRole('button', { name: 'URLをコピー' }));

      await waitFor(() => {
        expect(mockWriteText).toHaveBeenCalledWith(
          'https://default-copy.tenka.cloud'
        );
      });
    });

    it('URLをクリップボードにコピーすべき', async () => {
      const user = userEvent.setup();
      const mockCopyUrl = vi.fn().mockResolvedValue(undefined);

      render(
        <TenantAccessCard
          tenant={createMockTenant({ slug: 'copy-test' })}
          onCopyUrl={mockCopyUrl}
        />
      );

      await user.click(screen.getByRole('button', { name: 'URLをコピー' }));

      await waitFor(() => {
        expect(mockCopyUrl).toHaveBeenCalledWith(
          'https://copy-test.tenka.cloud'
        );
      });
    });

    it('コピー成功時に成功メッセージを表示すべき', async () => {
      const user = userEvent.setup();
      const mockCopyUrl = vi.fn().mockResolvedValue(undefined);

      render(
        <TenantAccessCard tenant={createMockTenant()} onCopyUrl={mockCopyUrl} />
      );

      await user.click(screen.getByRole('button', { name: 'URLをコピー' }));

      expect(await screen.findByText('コピーしました')).toBeInTheDocument();
    });

    it('コピー成功後2秒でステータスがリセットされるべき', async () => {
      const user = userEvent.setup();
      const mockCopyUrl = vi.fn().mockResolvedValue(undefined);

      render(
        <TenantAccessCard tenant={createMockTenant()} onCopyUrl={mockCopyUrl} />
      );

      await user.click(screen.getByRole('button', { name: 'URLをコピー' }));

      expect(await screen.findByText('コピーしました')).toBeInTheDocument();

      // Wait for the 2000ms setTimeout to fire
      await waitFor(
        () => {
          expect(screen.getByText('URLをコピー')).toBeInTheDocument();
        },
        { timeout: 3000 }
      );
    }, 10000);

    it('コピー失敗時にエラーメッセージを表示すべき', async () => {
      const user = userEvent.setup();
      const mockCopyUrl = vi
        .fn()
        .mockRejectedValue(new Error('Clipboard error'));

      render(
        <TenantAccessCard tenant={createMockTenant()} onCopyUrl={mockCopyUrl} />
      );

      await user.click(screen.getByRole('button', { name: 'URLをコピー' }));

      await waitFor(() => {
        expect(screen.getByText('コピーに失敗しました')).toBeInTheDocument();
      });
    });

    it('コピー失敗後2秒でステータスがリセットされるべき', async () => {
      const user = userEvent.setup();
      const mockCopyUrl = vi
        .fn()
        .mockRejectedValue(new Error('Clipboard error'));

      render(
        <TenantAccessCard tenant={createMockTenant()} onCopyUrl={mockCopyUrl} />
      );

      await user.click(screen.getByRole('button', { name: 'URLをコピー' }));

      await waitFor(() => {
        expect(screen.getByText('コピーに失敗しました')).toBeInTheDocument();
      });

      // Wait for the 2000ms setTimeout to fire
      await waitFor(
        () => {
          expect(screen.getByText('URLをコピー')).toBeInTheDocument();
        },
        { timeout: 3000 }
      );
    }, 10000);
  });

  describe('プロビジョニング状態', () => {
    it('PENDING 状態では管理画面リンクを無効化すべき', () => {
      render(
        <TenantAccessCard
          tenant={createMockTenant({ provisioningStatus: 'PENDING' })}
        />
      );
      const link = screen.getByRole('link', { name: '管理画面を開く' });
      expect(link).toHaveAttribute('aria-disabled', 'true');
    });

    it('IN_PROGRESS 状態では管理画面リンクを無効化すべき', () => {
      render(
        <TenantAccessCard
          tenant={createMockTenant({ provisioningStatus: 'IN_PROGRESS' })}
        />
      );
      const link = screen.getByRole('link', { name: '管理画面を開く' });
      expect(link).toHaveAttribute('aria-disabled', 'true');
    });

    it('FAILED 状態では管理画面リンクを無効化すべき', () => {
      render(
        <TenantAccessCard
          tenant={createMockTenant({ provisioningStatus: 'FAILED' })}
        />
      );
      const link = screen.getByRole('link', { name: '管理画面を開く' });
      expect(link).toHaveAttribute('aria-disabled', 'true');
    });

    it('COMPLETED 状態では管理画面リンクを有効化すべき', () => {
      render(
        <TenantAccessCard
          tenant={createMockTenant({ provisioningStatus: 'COMPLETED' })}
        />
      );
      const link = screen.getByRole('link', { name: '管理画面を開く' });
      expect(link).not.toHaveAttribute('aria-disabled', 'true');
    });

    it('プロビジョニング中はステータスメッセージを表示すべき', () => {
      render(
        <TenantAccessCard
          tenant={createMockTenant({ provisioningStatus: 'IN_PROGRESS' })}
        />
      );
      expect(screen.getByText(/プロビジョニング中/)).toBeInTheDocument();
    });

    it('プロビジョニング失敗時はエラーメッセージを表示すべき', () => {
      render(
        <TenantAccessCard
          tenant={createMockTenant({ provisioningStatus: 'FAILED' })}
        />
      );
      expect(screen.getByText(/プロビジョニング失敗/)).toBeInTheDocument();
    });
  });
});
