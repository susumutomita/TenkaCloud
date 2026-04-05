import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import LeaderboardPage from '../page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useParams: () => ({ eventId: 'evt-1' }),
}));

vi.mock('next-auth/react', () => ({
  SessionProvider: ({ children }: { children: React.ReactNode }) => children,
  useSession: () => ({ data: null, status: 'unauthenticated' }),
  getSession: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/tenant', () => ({
  getTenantId: vi.fn().mockReturnValue('test-tenant'),
  useTenantOptional: () => null,
}));

const mockGetEventDetails = vi.fn();
const mockGetLeaderboard = vi.fn();
vi.mock('@/lib/api/events', () => ({
  getEventDetails: (...args: unknown[]) => mockGetEventDetails(...args),
  getLeaderboard: (...args: unknown[]) => mockGetLeaderboard(...args),
}));

const baseEvent = {
  id: 'evt-1',
  name: 'テストGameDay',
  type: 'gameday',
  status: 'active',
  startTime: '2024-06-01T09:00:00Z',
  endTime: '2024-06-01T18:00:00Z',
  description: 'テスト用イベント',
  problems: [
    { id: 'p-1', title: '問題1', order: 1 },
    { id: 'p-2', title: '問題2', order: 2 },
  ],
  participantCount: 5,
  teamCount: 0,
  maxParticipants: 20,
  isRegistered: true,
};

const baseLeaderboard = {
  eventId: 'evt-1',
  entries: [
    {
      rank: 1,
      participantId: 'u-1',
      name: 'ユーザー1',
      totalScore: 500,
      problemScores: { 'p-1': 250, 'p-2': 250 },
      trend: 'same' as const,
      isMe: false,
    },
    {
      rank: 2,
      participantId: 'u-2',
      name: '私',
      totalScore: 400,
      problemScores: { 'p-1': 200, 'p-2': 200 },
      trend: 'up' as const,
      isMe: true,
    },
  ],
  isFrozen: false,
  updatedAt: '2024-06-01T12:00:00Z',
  myPosition: 2,
};

describe('LeaderboardPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ローディング中はデータを表示しないべき', () => {
    mockGetEventDetails.mockReturnValue(new Promise(() => {}));
    mockGetLeaderboard.mockReturnValue(new Promise(() => {}));
    render(<LeaderboardPage />);
    // Data-specific content should not be visible during loading
    expect(screen.queryByText('ユーザー1')).not.toBeInTheDocument();
  });

  it('APIからリーダーボードを取得して表示すべき', async () => {
    mockGetEventDetails.mockResolvedValue(baseEvent);
    mockGetLeaderboard.mockResolvedValue(baseLeaderboard);
    render(<LeaderboardPage />);

    await waitFor(() => {
      expect(screen.getByText('ユーザー1')).toBeInTheDocument();
    });
    expect(screen.getByText('私')).toBeInTheDocument();
    expect(screen.getByText('🥇')).toBeInTheDocument();
    expect(screen.getByText('#2')).toBeInTheDocument();
  });

  it('自分の順位を目立つ形で表示すべき', async () => {
    mockGetEventDetails.mockResolvedValue(baseEvent);
    mockGetLeaderboard.mockResolvedValue(baseLeaderboard);
    render(<LeaderboardPage />);

    await waitFor(() => {
      expect(screen.getByText('#2')).toBeInTheDocument();
    });
    // English locale: "Your rank"
    expect(screen.getByText('Your rank')).toBeInTheDocument();
  });

  it('リーダーボードが凍結されている場合に凍結バッジを表示すべき', async () => {
    mockGetEventDetails.mockResolvedValue(baseEvent);
    mockGetLeaderboard.mockResolvedValue({
      ...baseLeaderboard,
      isFrozen: true,
    });
    render(<LeaderboardPage />);

    await waitFor(() => {
      // English locale: "❄️ Frozen"
      expect(screen.getByText(/Frozen/)).toBeInTheDocument();
    });
  });

  it('エントリが空の場合に空状態メッセージを表示すべき', async () => {
    mockGetEventDetails.mockResolvedValue(baseEvent);
    mockGetLeaderboard.mockResolvedValue({
      ...baseLeaderboard,
      entries: [],
      myPosition: undefined,
    });
    render(<LeaderboardPage />);

    await waitFor(() => {
      // English locale: "No results yet"
      expect(screen.getByText('No results yet')).toBeInTheDocument();
    });
  });

  it('APIエラー時にエラーメッセージを表示すべき', async () => {
    mockGetEventDetails.mockRejectedValue(new Error('Network error'));
    mockGetLeaderboard.mockRejectedValue(new Error('Network error'));
    render(<LeaderboardPage />);

    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeInTheDocument();
    });
  });

  it('イベントへ戻るボタンを表示すべき', async () => {
    mockGetEventDetails.mockRejectedValue(new Error('fail'));
    mockGetLeaderboard.mockRejectedValue(new Error('fail'));
    render(<LeaderboardPage />);

    await waitFor(() => {
      const buttons = screen.getAllByRole('button');
      // English locale: "← Back to event"
      const backButton = buttons.find((b) =>
        b.textContent?.includes('Back to event'),
      );
      expect(backButton).toBeTruthy();
    });
  });

  it('myPosition がない場合は自分の順位セクションを表示しないべき', async () => {
    mockGetEventDetails.mockResolvedValue(baseEvent);
    mockGetLeaderboard.mockResolvedValue({
      ...baseLeaderboard,
      myPosition: undefined,
    });
    render(<LeaderboardPage />);

    await waitFor(() => {
      expect(screen.getByText('ユーザー1')).toBeInTheDocument();
    });
    expect(screen.queryByText('Your rank')).not.toBeInTheDocument();
  });

  it('問題ごとのスコア列を表示すべき', async () => {
    mockGetEventDetails.mockResolvedValue(baseEvent);
    mockGetLeaderboard.mockResolvedValue(baseLeaderboard);
    render(<LeaderboardPage />);

    await waitFor(() => {
      expect(screen.getByText('Q1')).toBeInTheDocument();
    });
    expect(screen.getByText('Q2')).toBeInTheDocument();
  });

  it('30秒ごとに自動更新すべき', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mockGetEventDetails.mockResolvedValue(baseEvent);
      mockGetLeaderboard.mockResolvedValue(baseLeaderboard);
      render(<LeaderboardPage />);

      await waitFor(() => {
        expect(mockGetLeaderboard).toHaveBeenCalledTimes(1);
      });

      vi.advanceTimersByTime(30000);

      await waitFor(() => {
        expect(mockGetLeaderboard).toHaveBeenCalledTimes(2);
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
