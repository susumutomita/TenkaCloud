import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchActivities } from '@/lib/api/activities-api';
import { fetchServiceConnections } from '@/lib/api/service-health';
import { fetchDashboardStats } from '@/lib/api/stats-api';
import { useAuth } from '@/lib/auth/auth-context';
import DashboardPage from '../page';

vi.mock('@/lib/auth/auth-context', () => ({
  useAuth: vi.fn(),
}));

vi.mock('@/lib/api/stats-api', () => ({
  fetchDashboardStats: vi.fn(),
}));

vi.mock('@/lib/api/activities-api', () => ({
  fetchActivities: vi.fn(),
}));

vi.mock('@/lib/api/service-health', () => ({
  fetchServiceConnections: vi.fn(),
  summarizeServiceConnections: vi.fn((services: Array<{ status: string }>) => {
    if (services.length === 0) return 'unknown';
    return services.every((s) => s.status === 'connected')
      ? 'healthy'
      : 'degraded';
  }),
}));

vi.mock('@cloudscape-design/components/box', () => ({
  default: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock('@cloudscape-design/components/button', () => ({
  default: ({ children }: { children?: React.ReactNode }) => (
    <button type="button">{children}</button>
  ),
}));

vi.mock('@cloudscape-design/components/column-layout', () => ({
  default: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock('@cloudscape-design/components/container', () => ({
  default: ({
    children,
    header,
  }: {
    children?: React.ReactNode;
    header?: React.ReactNode;
  }) => (
    <div>
      {header}
      {children}
    </div>
  ),
}));

vi.mock('@cloudscape-design/components/header', () => ({
  default: ({
    children,
    description,
    info,
  }: {
    children?: React.ReactNode;
    description?: React.ReactNode;
    info?: React.ReactNode;
  }) => (
    <div>
      <h2>{children}</h2>
      {description ? <p>{description}</p> : null}
      {info}
    </div>
  ),
}));

vi.mock('@cloudscape-design/components/space-between', () => ({
  default: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock('@cloudscape-design/components/status-indicator', () => ({
  default: ({ children }: { children?: React.ReactNode }) => (
    <output>{children}</output>
  ),
}));

vi.mock('@cloudscape-design/global-styles/index.css', () => ({}));

const authedSession = {
  session: {
    user: { email: 'admin@example.com', name: 'Admin', roles: [] },
    idToken: 'i',
    accessToken: 'a',
    expires: new Date(Date.now() + 60_000).toISOString(),
  },
  signIn: vi.fn(),
  signOut: vi.fn(),
  setTokens: vi.fn(),
};

describe('DashboardPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useAuth).mockReturnValue(authedSession);
    vi.mocked(fetchDashboardStats).mockResolvedValue({
      activeTenants: 5,
      totalTenants: 10,
      systemStatus: 'healthy',
      uptimePercentage: 99,
    });
    vi.mocked(fetchActivities).mockResolvedValue({
      data: [
        {
          id: 'a1',
          action: 'CREATE',
          resourceType: 'TENANT',
          timestamp: new Date(Date.now() - 30_000).toISOString(),
        },
        {
          id: 'a2',
          action: 'UPDATE',
          resourceType: 'USER',
          timestamp: new Date(Date.now() - 1000 * 60 * 5).toISOString(),
        },
        {
          id: 'a3',
          action: 'DELETE',
          resourceType: 'PROBLEM',
          timestamp: new Date(Date.now() - 1000 * 60 * 60 * 2).toISOString(),
        },
        {
          id: 'a4',
          action: 'LOGIN',
          resourceType: 'USER',
          timestamp: new Date(Date.now() - 1000 * 60 * 60 * 26).toISOString(),
        },
        {
          id: 'a5',
          action: 'ACCESS',
          resourceType: 'SYSTEM',
          timestamp: new Date(
            Date.now() - 1000 * 60 * 60 * 24 * 8,
          ).toISOString(),
        },
      ],
      pagination: { limit: 5, hasNextPage: false },
    });
    vi.mocked(fetchServiceConnections).mockResolvedValue([
      {
        id: 'tenant',
        name: 'Tenant',
        status: 'connected',
        checkedUrl: 'http://localhost/health',
      },
      {
        id: 'gameday',
        name: 'GameDay',
        status: 'unreachable',
        checkedUrl: 'http://localhost/health',
      },
    ]);
  });

  it('未認証なら何もレンダーしないべき', () => {
    vi.mocked(useAuth).mockReturnValue({ ...authedSession, session: null });
    const { container } = render(<DashboardPage />);
    expect(container.firstChild).toBeNull();
  });

  it('認証済みでヘッダーと統計を表示すべき', async () => {
    render(<DashboardPage />);
    expect(await screen.findByText('ダッシュボード')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText('5')).toBeInTheDocument();
      expect(screen.getByText('10')).toBeInTheDocument();
    });
  });

  it('アクティビティを表示すべき', async () => {
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByText(/テナントを作成しました/)).toBeInTheDocument();
    });
    expect(screen.getByText(/ユーザーを更新しました/)).toBeInTheDocument();
  });

  it('サービス接続が degraded 状態を表示すべき', async () => {
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByText('一部異常')).toBeInTheDocument();
    });
  });

  it('サービス接続が healthy 状態を表示すべき', async () => {
    vi.mocked(fetchServiceConnections).mockResolvedValue([
      {
        id: 'tenant',
        name: 'Tenant',
        status: 'connected',
        checkedUrl: 'http://localhost/health',
      },
    ]);
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByText('正常')).toBeInTheDocument();
    });
  });

  it('サービス接続が空なら未接続を表示すべき', async () => {
    vi.mocked(fetchServiceConnections).mockResolvedValue([]);
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByText('未接続')).toBeInTheDocument();
    });
    expect(
      screen.getByText('接続先を確認できませんでした'),
    ).toBeInTheDocument();
  });

  it('アクティビティが空なら空メッセージを表示すべき', async () => {
    vi.mocked(fetchActivities).mockResolvedValue({
      data: [],
      pagination: { limit: 5, hasNextPage: false },
    });
    render(<DashboardPage />);
    await waitFor(() => {
      expect(
        screen.getByText('アクティビティはありません'),
      ).toBeInTheDocument();
    });
  });

  it('API エラー時もレンダリングし続けるべき', async () => {
    vi.mocked(fetchDashboardStats).mockRejectedValue(new Error('boom'));
    vi.mocked(fetchActivities).mockRejectedValue(new Error('boom'));
    vi.mocked(fetchServiceConnections).mockRejectedValue(new Error('boom'));
    render(<DashboardPage />);
    expect(await screen.findByText('ダッシュボード')).toBeInTheDocument();
  });

  it('user.name が無い場合は email を表示すべき', async () => {
    vi.mocked(useAuth).mockReturnValue({
      ...authedSession,
      session: {
        ...authedSession.session,
        user: { email: 'noname@example.com', roles: [] },
      },
    });
    render(<DashboardPage />);
    expect(
      await screen.findByText(/ようこそ、noname@example.com さん/),
    ).toBeInTheDocument();
  });
});
