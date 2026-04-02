import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import RankingsPage from '../page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useParams: () => ({}),
}));

vi.mock('next-auth/react', () => ({
  SessionProvider: ({ children }: { children: React.ReactNode }) => children,
  useSession: () => ({ data: null, status: 'unauthenticated' }),
  getSession: vi.fn().mockResolvedValue(null),
}));

const mockGetGlobalRanking = vi.fn();
vi.mock('@/lib/api/profile', () => ({
  getGlobalRanking: (...args: unknown[]) => mockGetGlobalRanking(...args),
}));

const rankingsData = {
  rankings: [
    {
      rank: 1,
      userId: 'user-1',
      name: 'Taro',
      totalScore: 9500,
      eventsParticipated: 8,
    },
    {
      rank: 2,
      userId: 'user-2',
      name: 'Hanako',
      totalScore: 8200,
      eventsParticipated: 6,
    },
    {
      rank: 3,
      userId: 'user-3',
      name: 'Jiro',
      totalScore: 7100,
      eventsParticipated: 5,
    },
  ],
  total: 42,
  myRank: 2,
};

describe('ランキングページ', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('API データを取得して表示すべき', async () => {
    mockGetGlobalRanking.mockResolvedValue(rankingsData);
    render(<RankingsPage />);
    await waitFor(() => {
      expect(screen.getByText('Taro')).toBeInTheDocument();
      expect(screen.getByText('Hanako')).toBeInTheDocument();
      expect(screen.getByText('Jiro')).toBeInTheDocument();
    });
    // Stats cards should show real data
    expect(screen.getByText('42')).toBeInTheDocument();
    // Top score appears in both stats card and table row
    expect(screen.getAllByText('9,500')).toHaveLength(2);
  });

  it('ローディング中はスピナーを表示すべき', () => {
    mockGetGlobalRanking.mockReturnValue(new Promise(() => {}));
    render(<RankingsPage />);
    const spinners = document.querySelectorAll(
      '[class*="spinner"], [class*="loading"]'
    );
    expect(spinners.length).toBeGreaterThan(0);
  });

  it('API エラー時はエラーメッセージを表示すべき', async () => {
    mockGetGlobalRanking.mockRejectedValue(new Error('Network error'));
    render(<RankingsPage />);
    await waitFor(() => {
      expect(screen.getByText('再試行')).toBeInTheDocument();
    });
  });

  it('API エラー時はスタッツカードを非表示にすべき', async () => {
    mockGetGlobalRanking.mockRejectedValue(new Error('Network error'));
    render(<RankingsPage />);
    await waitFor(() => {
      expect(screen.getByText('再試行')).toBeInTheDocument();
    });
    expect(screen.queryByText('総参加者数')).not.toBeInTheDocument();
    expect(screen.queryByText('最高スコア')).not.toBeInTheDocument();
  });

  it('ランキングが空の場合はメッセージを表示すべき', async () => {
    mockGetGlobalRanking.mockResolvedValue({
      rankings: [],
      total: 0,
    });
    render(<RankingsPage />);
    await waitFor(() => {
      expect(
        screen.getByText('ランキングデータがありません')
      ).toBeInTheDocument();
    });
  });

  it('ランキングが空の場合は最高スコアに「-」を表示すべき', async () => {
    mockGetGlobalRanking.mockResolvedValue({
      rankings: [],
      total: 0,
    });
    render(<RankingsPage />);
    await waitFor(() => {
      expect(
        screen.getByText('ランキングデータがありません')
      ).toBeInTheDocument();
    });
    expect(screen.getByText('最高スコア')).toBeInTheDocument();
    expect(screen.getByText('-')).toBeInTheDocument();
  });

  it('myRank が存在する場合はバナーを表示すべき', async () => {
    mockGetGlobalRanking.mockResolvedValue(rankingsData);
    render(<RankingsPage />);
    await waitFor(() => {
      expect(screen.getByText(/あなたの現在の順位/)).toBeInTheDocument();
      expect(screen.getByText('2位')).toBeInTheDocument();
      expect(screen.getByText(/42人中/)).toBeInTheDocument();
    });
  });

  it('myRank が存在しない場合はバナーを非表示にすべき', async () => {
    mockGetGlobalRanking.mockResolvedValue({
      rankings: rankingsData.rankings,
      total: 42,
    });
    render(<RankingsPage />);
    await waitFor(() => {
      expect(screen.getByText('Taro')).toBeInTheDocument();
    });
    expect(screen.queryByText('あなたの現在の順位:')).not.toBeInTheDocument();
  });

  it('ページタイトル「ランキング」が表示されるべき', async () => {
    mockGetGlobalRanking.mockResolvedValue(rankingsData);
    render(<RankingsPage />);
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: 'ランキング' })
      ).toBeInTheDocument();
    });
  });

  it('参加者のスコアがフォーマットされて表示されるべき', async () => {
    mockGetGlobalRanking.mockResolvedValue(rankingsData);
    render(<RankingsPage />);
    await waitFor(() => {
      // Top score appears in both stats card and table row
      expect(screen.getAllByText('9,500')).toHaveLength(2);
      expect(screen.getByText('8,200')).toBeInTheDocument();
      expect(screen.getByText('7,100')).toBeInTheDocument();
    });
  });
});
