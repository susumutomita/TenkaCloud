import { render, screen } from '@testing-library/react';
import { usePathname } from 'next/navigation';
import { describe, expect, it, vi } from 'vitest';
import DashboardLayout from '../layout';

// next-auth/react のモック
vi.mock('next-auth/react', () => ({
  signOut: vi.fn(),
}));

// next/navigation のモック
vi.mock('next/navigation', () => ({
  usePathname: vi.fn(),
}));

describe('DashboardLayout コンポーネント', () => {
  it('children を正しくレンダリングすべき', () => {
    vi.mocked(usePathname).mockReturnValue('/dashboard');
    render(
      <DashboardLayout>
        <div>ダッシュボードコンテンツ</div>
      </DashboardLayout>
    );
    expect(screen.getByText('ダッシュボードコンテンツ')).toBeInTheDocument();
  });

  it('Sidebar を表示すべき', () => {
    vi.mocked(usePathname).mockReturnValue('/dashboard');
    render(
      <DashboardLayout>
        <div>テスト</div>
      </DashboardLayout>
    );
    expect(screen.getByText('TenkaCloud')).toBeInTheDocument();
  });

  it('ナビゲーションリンクを表示すべき', () => {
    vi.mocked(usePathname).mockReturnValue('/dashboard');
    render(
      <DashboardLayout>
        <div>テスト</div>
      </DashboardLayout>
    );
    expect(screen.getByText('ダッシュボード')).toBeInTheDocument();
    expect(screen.getByText('テナント管理')).toBeInTheDocument();
    expect(screen.getByText('設定')).toBeInTheDocument();
  });

  it('main 要素内に children を配置すべき', () => {
    vi.mocked(usePathname).mockReturnValue('/dashboard');
    render(
      <DashboardLayout>
        <div data-testid="dashboard-content">コンテンツ</div>
      </DashboardLayout>
    );
    const content = screen.getByTestId('dashboard-content');
    expect(content.closest('main')).toBeInTheDocument();
  });
});
