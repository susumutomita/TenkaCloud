import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import AdminDashboardPage from '../page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useParams: () => ({}),
}));

vi.mock('next-auth/react', () => ({
  SessionProvider: ({ children }: { children: React.ReactNode }) => children,
  useSession: () => ({ data: null, status: 'unauthenticated' }),
  getSession: vi.fn().mockResolvedValue(null),
}));

const mockUseTenantOptional = vi.fn().mockReturnValue(null);
vi.mock('@/lib/tenant', () => ({
  useTenantOptional: (...args: unknown[]) => mockUseTenantOptional(...args),
}));

const mockGetDashboardStats = vi.fn();
const mockGetRecentActivities = vi.fn();
vi.mock('@/lib/api/admin-dashboard', () => ({
  getDashboardStats: (...args: unknown[]) => mockGetDashboardStats(...args),
  getRecentActivities: (...args: unknown[]) => mockGetRecentActivities(...args),
}));

const statsData = {
  activeEvents: 3,
  totalParticipants: 245,
  totalTeams: 18,
  upcomingEvents: 7,
};

const activitiesData = {
  activities: [
    {
      id: 'act-1',
      type: 'event_started',
      message: 'Cloud Battle が開始されました',
      timestamp: new Date().toISOString(),
    },
    {
      id: 'act-2',
      type: 'participant_joined',
      message: '新しい参加者が登録しました',
      timestamp: new Date(Date.now() - 3600000).toISOString(),
    },
  ],
};

describe('Admin ダッシュボードページ', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ダッシュボード統計を API から取得して表示すべき', async () => {
    mockGetDashboardStats.mockResolvedValue(statsData);
    mockGetRecentActivities.mockResolvedValue({ activities: [] });
    render(<AdminDashboardPage />);

    await waitFor(() => {
      expect(screen.getByText('3')).toBeInTheDocument();
    });
    expect(screen.getByText('245')).toBeInTheDocument();
    expect(screen.getByText('18')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();

    expect(screen.getByText('開催中のイベント')).toBeInTheDocument();
    expect(screen.getByText('総参加者数')).toBeInTheDocument();
    expect(screen.getByText('総チーム数')).toBeInTheDocument();
    expect(screen.getByText('予定イベント')).toBeInTheDocument();
  });

  it('アクティビティを API から取得して表示すべき', async () => {
    mockGetDashboardStats.mockResolvedValue(statsData);
    mockGetRecentActivities.mockResolvedValue(activitiesData);
    render(<AdminDashboardPage />);

    await waitFor(() => {
      expect(
        screen.getByText('Cloud Battle が開始されました')
      ).toBeInTheDocument();
    });
    expect(screen.getByText('新しい参加者が登録しました')).toBeInTheDocument();
  });

  it('API エラー時はエラーメッセージを表示すべき', async () => {
    mockGetDashboardStats.mockRejectedValue(new Error('Network error'));
    mockGetRecentActivities.mockRejectedValue(new Error('Network error'));
    render(<AdminDashboardPage />);

    await waitFor(() => {
      expect(screen.getByText('再試行')).toBeInTheDocument();
    });
  });

  it('API エラー時はスタッツカードを非表示にすべき', async () => {
    mockGetDashboardStats.mockRejectedValue(new Error('Server error'));
    mockGetRecentActivities.mockRejectedValue(new Error('Server error'));
    render(<AdminDashboardPage />);

    await waitFor(() => {
      expect(screen.getByText('再試行')).toBeInTheDocument();
    });
    expect(screen.queryByText('開催中のイベント')).not.toBeInTheDocument();
    expect(screen.queryByText('総参加者数')).not.toBeInTheDocument();
    expect(screen.queryByText('総チーム数')).not.toBeInTheDocument();
    expect(screen.queryByText('予定イベント')).not.toBeInTheDocument();
  });

  it('API エラー時はアクティビティセクションを非表示にすべき', async () => {
    mockGetDashboardStats.mockRejectedValue(new Error('Server error'));
    mockGetRecentActivities.mockRejectedValue(new Error('Server error'));
    render(<AdminDashboardPage />);

    await waitFor(() => {
      expect(screen.getByText('再試行')).toBeInTheDocument();
    });
    expect(screen.queryByText('最近のアクティビティ')).not.toBeInTheDocument();
  });

  it('ローディング中はスケルトンを表示すべき', () => {
    mockGetDashboardStats.mockReturnValue(new Promise(() => {}));
    mockGetRecentActivities.mockReturnValue(new Promise(() => {}));
    render(<AdminDashboardPage />);

    const skeletons = document.querySelectorAll('[class*="animate-pulse"]');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it('アクティビティが空の場合はメッセージを表示すべき', async () => {
    mockGetDashboardStats.mockResolvedValue(statsData);
    mockGetRecentActivities.mockResolvedValue({ activities: [] });
    render(<AdminDashboardPage />);

    await waitFor(() => {
      expect(
        screen.getByText('まだアクティビティはありません')
      ).toBeInTheDocument();
    });
  });

  it('ページタイトル「ダッシュボード」が表示されるべき', async () => {
    mockGetDashboardStats.mockResolvedValue(statsData);
    mockGetRecentActivities.mockResolvedValue({ activities: [] });
    render(<AdminDashboardPage />);

    await waitFor(() => {
      expect(screen.getByText('ダッシュボード')).toBeInTheDocument();
    });
  });

  it('クイックアクションが表示されるべき', async () => {
    mockGetDashboardStats.mockResolvedValue(statsData);
    mockGetRecentActivities.mockResolvedValue({ activities: [] });
    render(<AdminDashboardPage />);

    await waitFor(() => {
      expect(screen.getByText('クイックアクション')).toBeInTheDocument();
    });
    expect(screen.getByText('新規イベント作成')).toBeInTheDocument();
    expect(screen.getByText('参加者を招待')).toBeInTheDocument();
    expect(screen.getByText('設定')).toBeInTheDocument();
  });

  it('全アクティビティタイプのアイコンが表示されるべき', async () => {
    mockGetDashboardStats.mockResolvedValue(statsData);
    mockGetRecentActivities.mockResolvedValue({
      activities: [
        {
          id: 'act-1',
          type: 'event_created',
          message: 'イベントが作成されました',
          timestamp: new Date(Date.now() - 3600000).toISOString(),
        },
        {
          id: 'act-2',
          type: 'event_ended',
          message: 'イベントが終了しました',
          timestamp: new Date(Date.now() - 7200000).toISOString(),
        },
        {
          id: 'act-3',
          type: 'unknown_type',
          message: '不明なアクティビティ',
          timestamp: new Date(Date.now() - 7200000).toISOString(),
        },
      ],
    });
    render(<AdminDashboardPage />);

    await waitFor(() => {
      expect(screen.getByText('イベントが作成されました')).toBeInTheDocument();
    });
    expect(screen.getByText('イベントが終了しました')).toBeInTheDocument();
    expect(screen.getByText('不明なアクティビティ')).toBeInTheDocument();
  });

  it('数分前のタイムスタンプを「N分前」と表示すべき', async () => {
    mockGetDashboardStats.mockResolvedValue(statsData);
    mockGetRecentActivities.mockResolvedValue({
      activities: [
        {
          id: 'act-1',
          type: 'event_started',
          message: '最近のアクティビティ',
          timestamp: new Date(Date.now() - 300000).toISOString(),
        },
      ],
    });
    render(<AdminDashboardPage />);

    await waitFor(() => {
      expect(screen.getByText('最近のアクティビティ')).toBeInTheDocument();
    });
    expect(screen.getByText('5分前')).toBeInTheDocument();
  });

  it('直前のタイムスタンプを「たった今」と表示すべき', async () => {
    mockGetDashboardStats.mockResolvedValue(statsData);
    mockGetRecentActivities.mockResolvedValue({
      activities: [
        {
          id: 'act-1',
          type: 'event_started',
          message: '今すぐのアクティビティ',
          timestamp: new Date().toISOString(),
        },
      ],
    });
    render(<AdminDashboardPage />);

    await waitFor(() => {
      expect(screen.getByText('今すぐのアクティビティ')).toBeInTheDocument();
    });
    expect(screen.getByText('たった今')).toBeInTheDocument();
  });

  it('24時間以上前のタイムスタンプを日本語日付で表示すべき', async () => {
    mockGetDashboardStats.mockResolvedValue(statsData);
    mockGetRecentActivities.mockResolvedValue({
      activities: [
        {
          id: 'act-1',
          type: 'event_started',
          message: '古いアクティビティ',
          timestamp: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
        },
      ],
    });
    render(<AdminDashboardPage />);

    await waitFor(() => {
      expect(screen.getByText('古いアクティビティ')).toBeInTheDocument();
    });
  });

  it('Error 以外の例外が投げられた場合もエラーを表示すべき', async () => {
    mockGetDashboardStats.mockRejectedValue('string error');
    mockGetRecentActivities.mockRejectedValue('string error');
    render(<AdminDashboardPage />);

    await waitFor(() => {
      expect(screen.getByText('再試行')).toBeInTheDocument();
    });
  });

  it('統計値が undefined の場合にフォールバック表示すべき', async () => {
    mockGetDashboardStats.mockResolvedValue({});
    mockGetRecentActivities.mockResolvedValue({ activities: [] });
    render(<AdminDashboardPage />);

    await waitFor(() => {
      expect(screen.getByText('開催中のイベント')).toBeInTheDocument();
    });
    const dashes = screen.getAllByText('-');
    expect(dashes.length).toBeGreaterThanOrEqual(4);
  });

  it('テナントスラッグがある場合に表示すべき', async () => {
    mockUseTenantOptional.mockReturnValue({ slug: 'test-org' });
    mockGetDashboardStats.mockResolvedValue(statsData);
    mockGetRecentActivities.mockResolvedValue({ activities: [] });
    render(<AdminDashboardPage />);

    await waitFor(() => {
      expect(screen.getByText(/test-org/)).toBeInTheDocument();
    });
  });
});
