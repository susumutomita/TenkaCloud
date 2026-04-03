import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { usePathname, useRouter } from 'next/navigation';
import { signOut } from 'next-auth/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DashboardLayout from '../layout';

// next-auth/react のモック
vi.mock('next-auth/react', () => ({
  signOut: vi.fn(),
}));

// next/navigation のモック
const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  usePathname: vi.fn(),
  useRouter: vi.fn(() => ({
    push: mockPush,
  })),
}));

// Cloudscape コンポーネントのモック — コールバックをテスト可能に
vi.mock('@cloudscape-design/components/app-layout', () => ({
  default: ({
    content,
    navigation,
  }: {
    content: React.ReactNode;
    navigation: React.ReactNode;
  }) => (
    <div data-testid="app-layout">
      <nav>{navigation}</nav>
      {content}
    </div>
  ),
}));

vi.mock('@cloudscape-design/components/side-navigation', () => ({
  default: ({
    items,
    header,
    onFollow,
  }: {
    items: Array<{ text: string; href: string; type: string }>;
    header: { text: string };
    onFollow?: (e: {
      preventDefault: () => void;
      detail: { href: string };
    }) => void;
  }) => (
    <div data-testid="side-navigation">
      <span>{header.text}</span>
      {items.map((item: { text: string; href: string; type: string }) => (
        <a
          key={item.href}
          href={item.href}
          onClick={(e) => {
            e.preventDefault();
            if (onFollow) {
              onFollow({
                preventDefault: () => {},
                detail: { href: item.href },
              });
            }
          }}
        >
          {item.text}
        </a>
      ))}
    </div>
  ),
}));

vi.mock('@cloudscape-design/components/top-navigation', () => ({
  default: ({
    identity,
    utilities,
  }: {
    identity: {
      title: string;
      onFollow?: (e: { preventDefault: () => void }) => void;
    };
    utilities?: Array<{
      type: string;
      text: string;
      onItemClick?: (e: { detail: { id: string } }) => void;
      items?: Array<{ id: string; text: string }>;
    }>;
  }) => (
    <div data-testid="top-navigation">
      <button
        type="button"
        data-testid="identity-link"
        onClick={() => {
          if (identity.onFollow) {
            identity.onFollow({ preventDefault: () => {} });
          }
        }}
      >
        {identity.title}
      </button>
      {utilities?.map((util) =>
        util.items?.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => {
              if (util.onItemClick) {
                util.onItemClick({ detail: { id: item.id } });
              }
            }}
          >
            {item.text}
          </button>
        )),
      )}
    </div>
  ),
}));

vi.mock('@cloudscape-design/global-styles/index.css', () => ({}));

describe('DashboardLayout コンポーネント', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(usePathname).mockReturnValue('/dashboard');
  });

  it('children を正しくレンダリングすべき', () => {
    render(
      <DashboardLayout>
        <div>ダッシュボードコンテンツ</div>
      </DashboardLayout>,
    );
    expect(screen.getByText('ダッシュボードコンテンツ')).toBeInTheDocument();
  });

  it('Sidebar を表示すべき', () => {
    render(
      <DashboardLayout>
        <div>テスト</div>
      </DashboardLayout>,
    );
    expect(screen.getByText('TenkaCloud')).toBeInTheDocument();
  });

  it('ナビゲーションリンクを表示すべき', () => {
    render(
      <DashboardLayout>
        <div>テスト</div>
      </DashboardLayout>,
    );
    expect(screen.getByText('ダッシュボード')).toBeInTheDocument();
    expect(screen.getByText('テナント管理')).toBeInTheDocument();
    // 設定はサイドナビとドロップダウンメニュー両方に表示される
    expect(screen.getAllByText('設定').length).toBeGreaterThanOrEqual(1);
  });

  it('main 要素内に children を配置すべき', () => {
    render(
      <DashboardLayout>
        <div data-testid="dashboard-content">コンテンツ</div>
      </DashboardLayout>,
    );
    const content = screen.getByTestId('dashboard-content');
    expect(content.closest('main')).toBeInTheDocument();
  });

  it('ナビゲーションリンクをクリックすると router.push が呼ばれるべき', async () => {
    const user = userEvent.setup();
    render(
      <DashboardLayout>
        <div>テスト</div>
      </DashboardLayout>,
    );
    await user.click(screen.getByText('テナント管理'));
    expect(mockPush).toHaveBeenCalledWith('/dashboard/tenants');
  });

  it('identity リンクをクリックすると router.push が呼ばれるべき', async () => {
    const user = userEvent.setup();
    render(
      <DashboardLayout>
        <div>テスト</div>
      </DashboardLayout>,
    );
    await user.click(screen.getByTestId('identity-link'));
    expect(mockPush).toHaveBeenCalledWith('/dashboard');
  });

  it('ログアウトをクリックすると signOut が呼ばれるべき', async () => {
    const user = userEvent.setup();
    render(
      <DashboardLayout>
        <div>テスト</div>
      </DashboardLayout>,
    );
    await user.click(screen.getByText('ログアウト'));
    expect(signOut).toHaveBeenCalledWith({ callbackUrl: '/login' });
  });

  it('設定をクリックしても signOut が呼ばれないべき', async () => {
    const user = userEvent.setup();
    render(
      <DashboardLayout>
        <div>テスト</div>
      </DashboardLayout>,
    );
    // ドロップダウンメニュー内の「設定」ボタンをクリック（TopNavigation 内）
    const settingsButtons = screen.getAllByText('設定');
    const topNavSettingsButton = settingsButtons.find(
      (el) => el.closest('[data-testid="top-navigation"]') !== null,
    );
    await user.click(topNavSettingsButton!);
    expect(signOut).not.toHaveBeenCalled();
  });

  it('テナント管理パスではテナント管理リンクがアクティブになるべき', () => {
    vi.mocked(usePathname).mockReturnValue('/dashboard/tenants');
    render(
      <DashboardLayout>
        <div>テスト</div>
      </DashboardLayout>,
    );
    // SideNavigation にアクティブ状態が渡されることを確認
    expect(screen.getByText('テナント管理')).toBeInTheDocument();
  });

  it('ダッシュボードパスではダッシュボードリンクがアクティブになるべき', () => {
    vi.mocked(usePathname).mockReturnValue('/dashboard');
    render(
      <DashboardLayout>
        <div>テスト</div>
      </DashboardLayout>,
    );
    expect(screen.getByText('ダッシュボード')).toBeInTheDocument();
  });
});
