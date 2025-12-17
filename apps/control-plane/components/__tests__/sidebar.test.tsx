import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { usePathname } from 'next/navigation';
import { signOut } from 'next-auth/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Sidebar } from '../sidebar';

// next-auth/react のモック
vi.mock('next-auth/react', () => ({
  signOut: vi.fn(),
}));

// next/navigation のモック
vi.mock('next/navigation', () => ({
  usePathname: vi.fn(),
}));

describe('Sidebar コンポーネント', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(usePathname).mockReturnValue('/dashboard');
  });

  describe('レンダリング', () => {
    it('ロゴを表示すべき', () => {
      render(<Sidebar />);
      expect(screen.getByText('TenkaCloud')).toBeInTheDocument();
    });

    it('ナビゲーションリンクを表示すべき', () => {
      render(<Sidebar />);
      expect(screen.getByText('ダッシュボード')).toBeInTheDocument();
      expect(screen.getByText('テナント管理')).toBeInTheDocument();
      expect(screen.getByText('設定')).toBeInTheDocument();
    });

    it('ログアウトボタンを表示すべき', () => {
      render(<Sidebar />);
      expect(screen.getByText('ログアウト')).toBeInTheDocument();
    });

    it('各ナビゲーションリンクが正しい href を持つべき', () => {
      render(<Sidebar />);
      expect(screen.getByText('ダッシュボード').closest('a')).toHaveAttribute(
        'href',
        '/dashboard'
      );
      expect(screen.getByText('テナント管理').closest('a')).toHaveAttribute(
        'href',
        '/dashboard/tenants'
      );
      expect(screen.getByText('設定').closest('a')).toHaveAttribute(
        'href',
        '/dashboard/settings'
      );
    });
  });

  describe('アクティブ状態', () => {
    it('現在のパスに一致するリンクがアクティブスタイルを持つべき', () => {
      vi.mocked(usePathname).mockReturnValue('/dashboard');
      render(<Sidebar />);
      const dashboardLink = screen.getByText('ダッシュボード').closest('a');
      expect(dashboardLink).toHaveClass('bg-gray-800');
      expect(dashboardLink).toHaveClass('text-white');
    });

    it('テナント管理ページでテナント管理リンクがアクティブになるべき', () => {
      vi.mocked(usePathname).mockReturnValue('/dashboard/tenants');
      render(<Sidebar />);
      const tenantsLink = screen.getByText('テナント管理').closest('a');
      expect(tenantsLink).toHaveClass('bg-gray-800');
    });

    it('テナント詳細ページでもテナント管理リンクがアクティブになるべき', () => {
      vi.mocked(usePathname).mockReturnValue('/dashboard/tenants/123');
      render(<Sidebar />);
      const tenantsLink = screen.getByText('テナント管理').closest('a');
      expect(tenantsLink).toHaveClass('bg-gray-800');
    });

    it('設定ページで設定リンクがアクティブになるべき', () => {
      vi.mocked(usePathname).mockReturnValue('/dashboard/settings');
      render(<Sidebar />);
      const settingsLink = screen.getByText('設定').closest('a');
      expect(settingsLink).toHaveClass('bg-gray-800');
    });

    it('非アクティブなリンクは異なるスタイルを持つべき', () => {
      vi.mocked(usePathname).mockReturnValue('/dashboard');
      render(<Sidebar />);
      const tenantsLink = screen.getByText('テナント管理').closest('a');
      expect(tenantsLink).toHaveClass('text-gray-300');
    });
  });

  describe('ログアウト', () => {
    it('ログアウトボタンをクリックすると signOut が呼ばれるべき', async () => {
      const user = userEvent.setup();
      render(<Sidebar />);

      await user.click(screen.getByText('ログアウト'));
      expect(signOut).toHaveBeenCalledWith({ callbackUrl: '/login' });
    });
  });

  describe('pathname が null の場合', () => {
    it('エラーなくレンダリングされるべき', () => {
      vi.mocked(usePathname).mockReturnValue(null as unknown as string);
      render(<Sidebar />);
      expect(screen.getByText('TenkaCloud')).toBeInTheDocument();
    });
  });
});
