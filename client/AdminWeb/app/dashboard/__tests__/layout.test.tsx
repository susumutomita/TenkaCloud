import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { usePathname } from 'next/navigation';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuth } from '@/lib/auth/auth-context';
import DashboardLayout from '../layout';

const signOutMock = vi.fn();

vi.mock('@/lib/auth/auth-context', () => ({
  useAuth: vi.fn(),
}));

const mockPush = vi.fn();
const mockReplace = vi.fn();
vi.mock('next/navigation', () => ({
  usePathname: vi.fn(),
  useRouter: vi.fn(() => ({
    push: mockPush,
    replace: mockReplace,
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
    activeHref,
    onFollow,
  }: {
    items: Array<{ text: string; href: string; type: string }>;
    header: { text: string };
    activeHref?: string;
    onFollow?: (e: {
      preventDefault: () => void;
      detail: { href: string };
    }) => void;
  }) => (
    <div data-testid="side-navigation" data-active-href={activeHref}>
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
      {utilities?.map((util) => [
        ...(util.items?.map((item) => (
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
        )) ?? []),
        <button
          key={`${util.text}-unknown`}
          type="button"
          onClick={() => {
            if (util.onItemClick) {
              util.onItemClick({ detail: { id: 'unknown' } });
            }
          }}
        >
          不明なメニュー
        </button>,
      ])}
    </div>
  ),
}));

vi.mock('@cloudscape-design/global-styles/index.css', () => ({}));

describe('DashboardLayout コンポーネント', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(usePathname).mockReturnValue('/dashboard');
    vi.mocked(useAuth).mockReturnValue({
      session: {
        user: { email: 'test@example.com', name: 'Test', roles: [] },
        idToken: 'idt',
        accessToken: 'at',
        expires: new Date(Date.now() + 60_000).toISOString(),
      },
      signIn: vi.fn(),
      signOut: signOutMock,
      setTokens: vi.fn(),
    });
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
    expect(signOutMock).toHaveBeenCalled();
    expect(mockPush).toHaveBeenCalledWith('/login');
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
    if (!topNavSettingsButton) throw new Error('button not found');
    await user.click(topNavSettingsButton);
    expect(signOutMock).not.toHaveBeenCalled();
  });

  it('未対応メニューをクリックしても遷移もログアウトも行わないべき', async () => {
    const user = userEvent.setup();
    render(
      <DashboardLayout>
        <div>テスト</div>
      </DashboardLayout>,
    );

    await user.click(screen.getByRole('button', { name: '不明なメニュー' }));

    expect(mockPush).not.toHaveBeenCalled();
    expect(signOutMock).not.toHaveBeenCalled();
  });

  it('テナント管理パスではテナント管理リンクがアクティブになるべき', () => {
    vi.mocked(usePathname).mockReturnValue('/dashboard/tenants');
    render(
      <DashboardLayout>
        <div>テスト</div>
      </DashboardLayout>,
    );
    expect(screen.getByTestId('side-navigation')).toHaveAttribute(
      'data-active-href',
      '/control/dashboard/tenants',
    );
  });

  it('ダッシュボードパスではダッシュボードリンクがアクティブになるべき', () => {
    vi.mocked(usePathname).mockReturnValue('/dashboard');
    render(
      <DashboardLayout>
        <div>テスト</div>
      </DashboardLayout>,
    );
    expect(screen.getByTestId('side-navigation')).toHaveAttribute(
      'data-active-href',
      '/control/dashboard',
    );
  });

  it('未認証 (session=null) なら /login へ replace すべき', () => {
    vi.mocked(useAuth).mockReturnValue({
      session: null,
      signIn: vi.fn(),
      signOut: signOutMock,
      setTokens: vi.fn(),
    });
    render(
      <DashboardLayout>
        <div>テスト</div>
      </DashboardLayout>,
    );
    expect(mockReplace).toHaveBeenCalledWith('/login');
  });

  it('類似パスでは前方一致で誤ってアクティブにしないべき', () => {
    vi.mocked(usePathname).mockReturnValue('/dashboard/tenants-legacy');
    render(
      <DashboardLayout>
        <div>テスト</div>
      </DashboardLayout>,
    );
    expect(screen.getByTestId('side-navigation')).not.toHaveAttribute(
      'data-active-href',
      '/control/dashboard/tenants',
    );
  });
});
