import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import AdminAnalyticsPage from '../page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useParams: () => ({}),
}));

vi.mock('next-auth/react', () => ({
  SessionProvider: ({ children }: { children: React.ReactNode }) => children,
  useSession: () => ({ data: null, status: 'unauthenticated' }),
}));

const mockGetAnalyticsData = vi.fn();
vi.mock('@/lib/api/admin-analytics', () => ({
  getAnalyticsData: (...args: unknown[]) => mockGetAnalyticsData(...args),
}));

const analyticsData = {
  overview: {
    totalEvents: 12,
    totalParticipants: 245,
    avgScore: 72,
    completionRate: 85,
  },
  eventTimeline: [
    { month: '2026-01', eventCount: 3, participantCount: 50 },
    { month: '2026-02', eventCount: 5, participantCount: 80 },
    { month: '2026-03', eventCount: 4, participantCount: 115 },
  ],
  scoreDistribution: [
    { category: '0-20', value: 1 },
    { category: '21-40', value: 3 },
    { category: '41-60', value: 5 },
    { category: '61-80', value: 7 },
    { category: '81-100', value: 2 },
  ],
  teamComparison: [
    { teamName: 'チームA', score: 85, memberCount: 4, completionRate: 90 },
    { teamName: 'チームB', score: 72, memberCount: 3, completionRate: 80 },
    { teamName: 'チームC', score: 60, memberCount: 5, completionRate: 70 },
  ],
};

describe('Admin 分析ページ', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ページタイトル「分析ダッシュボード」が表示されるべき', async () => {
    mockGetAnalyticsData.mockResolvedValue(analyticsData);
    render(<AdminAnalyticsPage />);

    await waitFor(() => {
      expect(screen.getByText('分析ダッシュボード')).toBeInTheDocument();
    });
  });

  it('概要メトリクスを表示すべき', async () => {
    mockGetAnalyticsData.mockResolvedValue(analyticsData);
    render(<AdminAnalyticsPage />);

    await waitFor(() => {
      expect(screen.getByText('総イベント数')).toBeInTheDocument();
    });
    expect(screen.getByText('総参加者数')).toBeInTheDocument();
    expect(screen.getByText('平均スコア')).toBeInTheDocument();
    expect(screen.getByText('完了率')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('245')).toBeInTheDocument();
    expect(screen.getByText('72')).toBeInTheDocument();
    expect(screen.getByText('85%')).toBeInTheDocument();
  });

  it('タブが表示されるべき', async () => {
    mockGetAnalyticsData.mockResolvedValue(analyticsData);
    render(<AdminAnalyticsPage />);

    await waitFor(() => {
      expect(screen.getByText('概要')).toBeInTheDocument();
    });
    expect(screen.getByText('イベント分析')).toBeInTheDocument();
    expect(screen.getByText('スコア分布')).toBeInTheDocument();
    expect(screen.getByText('チーム比較')).toBeInTheDocument();
  });

  it('ローディング中はスピナーを表示すべき', () => {
    mockGetAnalyticsData.mockReturnValue(new Promise(() => {}));
    render(<AdminAnalyticsPage />);

    const spinners = document.querySelectorAll('[class*="awsui_root"]');
    expect(spinners.length).toBeGreaterThan(0);
  });

  it('API エラー時はエラーメッセージを表示すべき', async () => {
    mockGetAnalyticsData.mockRejectedValue(new Error('Network error'));
    render(<AdminAnalyticsPage />);

    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeInTheDocument();
    });
    expect(screen.getByText('再試行')).toBeInTheDocument();
  });

  it('Error 以外の例外が投げられた場合もエラーを表示すべき', async () => {
    mockGetAnalyticsData.mockRejectedValue('string error');
    render(<AdminAnalyticsPage />);

    await waitFor(() => {
      expect(
        screen.getByText('分析データの読み込みに失敗しました'),
      ).toBeInTheDocument();
    });
  });

  it('CSV エクスポートボタンが表示されるべき', async () => {
    mockGetAnalyticsData.mockResolvedValue(analyticsData);
    render(<AdminAnalyticsPage />);

    await waitFor(() => {
      expect(screen.getByText('CSV エクスポート')).toBeInTheDocument();
    });
  });

  it('CSV エクスポートボタンをクリックするとダウンロードが開始されるべき', async () => {
    mockGetAnalyticsData.mockResolvedValue(analyticsData);
    const mockClick = vi.fn();
    const mockCreateObjectURL = vi.fn().mockReturnValue('blob:test');
    const mockRevokeObjectURL = vi.fn();

    vi.spyOn(URL, 'createObjectURL').mockImplementation(mockCreateObjectURL);
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(mockRevokeObjectURL);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      if (tag === 'a') {
        return {
          href: '',
          download: '',
          click: mockClick,
          set setAttribute(_val: string) {
            /* noop */
          },
        } as unknown as HTMLAnchorElement;
      }
      return document.createElementNS(
        'http://www.w3.org/1999/xhtml',
        tag,
      ) as HTMLElement;
    });

    render(<AdminAnalyticsPage />);

    await waitFor(() => {
      expect(screen.getByText('CSV エクスポート')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('CSV エクスポート'));

    expect(mockCreateObjectURL).toHaveBeenCalled();
    expect(mockClick).toHaveBeenCalled();
    expect(mockRevokeObjectURL).toHaveBeenCalledWith('blob:test');

    vi.restoreAllMocks();
  });

  it('チーム比較タブでチームデータを表示すべき', async () => {
    mockGetAnalyticsData.mockResolvedValue(analyticsData);
    render(<AdminAnalyticsPage />);

    await waitFor(() => {
      expect(screen.getByText('チーム比較')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('チーム比較'));

    await waitFor(() => {
      expect(screen.getByText('チームA')).toBeInTheDocument();
    });
    expect(screen.getByText('チームB')).toBeInTheDocument();
    expect(screen.getByText('チームC')).toBeInTheDocument();
  });

  it('期間選択フィルタが表示されるべき', async () => {
    mockGetAnalyticsData.mockResolvedValue(analyticsData);
    render(<AdminAnalyticsPage />);

    await waitFor(() => {
      expect(screen.getByText('全期間')).toBeInTheDocument();
    });
  });

  it('再試行ボタンをクリックするとデータを再取得すべき', async () => {
    mockGetAnalyticsData.mockRejectedValueOnce(new Error('Network error'));
    render(<AdminAnalyticsPage />);

    await waitFor(() => {
      expect(screen.getByText('再試行')).toBeInTheDocument();
    });

    mockGetAnalyticsData.mockResolvedValueOnce(analyticsData);
    fireEvent.click(screen.getByText('再試行'));

    await waitFor(() => {
      expect(screen.getByText('分析ダッシュボード')).toBeInTheDocument();
    });
    expect(mockGetAnalyticsData).toHaveBeenCalledTimes(2);
  });
});
