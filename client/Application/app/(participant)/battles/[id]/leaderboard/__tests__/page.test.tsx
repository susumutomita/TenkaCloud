import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import BattleLeaderboardPage from '../page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useParams: () => ({ id: 'battle-1' }),
}));

vi.mock('next-auth/react', () => ({
  SessionProvider: ({ children }: { children: React.ReactNode }) => children,
  useSession: () => ({ data: null, status: 'unauthenticated' }),
  getSession: vi.fn().mockResolvedValue(null),
}));

const mockGetEventDetails = vi.fn();
const mockGetLeaderboard = vi.fn();

vi.mock('@/lib/api/events', () => ({
  getEventDetails: (...args: unknown[]) => mockGetEventDetails(...args),
  getLeaderboard: (...args: unknown[]) => mockGetLeaderboard(...args),
}));

// SSE was removed; the page uses polling now. No EventSource stub needed.

const battleData = {
  id: 'battle-1',
  name: 'AWS GameDay 2025',
  type: 'gameday' as const,
  status: 'active' as const,
  startTime: '2025-01-01T09:00:00Z',
  endTime: '2025-01-01T17:00:00Z',
  timezone: 'Asia/Tokyo',
  participantType: 'individual' as const,
  cloudProvider: 'aws' as const,
  regions: ['ap-northeast-1'],
  scoringType: 'realtime' as const,
  leaderboardVisible: true,
  problemCount: 1,
  participantCount: 42,
  isRegistered: true,
  problems: [
    {
      id: 'prob-1',
      title: 'S3 バケット構築',
      type: 'gameday' as const,
      category: 'architecture' as const,
      difficulty: 'easy' as const,
      overview: 'S3 バケットを作成',
      objectives: ['作成'],
      order: 1,
      isUnlocked: true,
      pointMultiplier: 1,
      maxScore: 100,
      isCompleted: false,
    },
  ],
};

const leaderboardData = {
  eventId: 'battle-1',
  entries: [
    {
      rank: 1,
      participantId: 'p-1',
      name: 'Taro',
      totalScore: 100,
      problemScores: { 'prob-1': 100 },
      trend: 'same' as const,
      isMe: false,
    },
    {
      rank: 2,
      participantId: 'p-2',
      name: 'Hanako',
      totalScore: 80,
      problemScores: { 'prob-1': 80 },
      trend: 'up' as const,
      isMe: true,
    },
    {
      rank: 3,
      participantId: 'p-3',
      name: 'Jiro',
      totalScore: 60,
      problemScores: { 'prob-1': 60 },
      trend: 'down' as const,
      isMe: false,
    },
  ],
  isFrozen: false,
  updatedAt: '2025-01-01T12:00:00Z',
  myPosition: 2,
};

describe('リーダーボードページ', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ページタイトル「リーダーボード」が表示されるべき', async () => {
    mockGetEventDetails.mockResolvedValue(battleData);
    mockGetLeaderboard.mockResolvedValue(leaderboardData);
    render(<BattleLeaderboardPage />);
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: 'リーダーボード' }),
      ).toBeInTheDocument();
    });
  });

  it('ローディングスピナーが初期表示されるべき', () => {
    mockGetEventDetails.mockReturnValue(new Promise(() => {}));
    mockGetLeaderboard.mockReturnValue(new Promise(() => {}));
    render(<BattleLeaderboardPage />);
    expect(document.querySelector('.animate-spin')).toBeInTheDocument();
  });

  it('参加者の順位と名前とスコアが表示されるべき', async () => {
    mockGetEventDetails.mockResolvedValue(battleData);
    mockGetLeaderboard.mockResolvedValue(leaderboardData);
    render(<BattleLeaderboardPage />);
    await waitFor(() => {
      expect(screen.getByText('Taro')).toBeInTheDocument();
      expect(screen.getByText('Hanako')).toBeInTheDocument();
      expect(screen.getByText('Jiro')).toBeInTheDocument();
    });
  });

  it('自分の順位カードが表示されるべき', async () => {
    mockGetEventDetails.mockResolvedValue(battleData);
    mockGetLeaderboard.mockResolvedValue(leaderboardData);
    render(<BattleLeaderboardPage />);
    await waitFor(() => {
      expect(screen.getByText('あなたの順位')).toBeInTheDocument();
      // "#2" appears in both myPosition card and the table row
      expect(screen.getAllByText('#2')).toHaveLength(2);
    });
  });

  it('自分のエントリに「自分」バッジが表示されるべき', async () => {
    mockGetEventDetails.mockResolvedValue(battleData);
    mockGetLeaderboard.mockResolvedValue(leaderboardData);
    render(<BattleLeaderboardPage />);
    await waitFor(() => {
      expect(screen.getByText('自分')).toBeInTheDocument();
    });
  });

  it('推移アイコンが表示されるべき', async () => {
    mockGetEventDetails.mockResolvedValue(battleData);
    mockGetLeaderboard.mockResolvedValue(leaderboardData);
    render(<BattleLeaderboardPage />);
    await waitFor(() => {
      expect(screen.getByText('↑')).toBeInTheDocument();
      expect(screen.getByText('↓')).toBeInTheDocument();
      expect(screen.getByText('-')).toBeInTheDocument();
    });
  });

  it('凍結中のリーダーボードに凍結バッジが表示されるべき', async () => {
    mockGetEventDetails.mockResolvedValue(battleData);
    mockGetLeaderboard.mockResolvedValue({
      ...leaderboardData,
      isFrozen: true,
    });
    render(<BattleLeaderboardPage />);
    await waitFor(() => {
      expect(screen.getByText('凍結中')).toBeInTheDocument();
    });
  });

  it('エラー時にエラー表示されるべき', async () => {
    mockGetEventDetails.mockRejectedValue(new Error('Network error'));
    mockGetLeaderboard.mockRejectedValue(new Error('Network error'));
    render(<BattleLeaderboardPage />);
    await waitFor(() => {
      expect(screen.getByText('再試行')).toBeInTheDocument();
    });
  });

  it('ポーリング中は更新中バッジが表示されるべき', async () => {
    mockGetEventDetails.mockResolvedValue(battleData);
    mockGetLeaderboard.mockResolvedValue(leaderboardData);
    render(<BattleLeaderboardPage />);
    await waitFor(() => {
      expect(screen.getByText('更新中')).toBeInTheDocument();
    });
  });

  it('参加者合計数が表示されるべき', async () => {
    mockGetEventDetails.mockResolvedValue(battleData);
    mockGetLeaderboard.mockResolvedValue(leaderboardData);
    render(<BattleLeaderboardPage />);
    await waitFor(() => {
      expect(screen.getByText('全 3 チーム/参加者')).toBeInTheDocument();
    });
  });

  it('エントリが0件のとき空状態メッセージが表示されるべき', async () => {
    mockGetEventDetails.mockResolvedValue(battleData);
    mockGetLeaderboard.mockResolvedValue({
      ...leaderboardData,
      entries: [],
    });
    render(<BattleLeaderboardPage />);
    await waitFor(() => {
      expect(screen.getByText('まだ結果がありません')).toBeInTheDocument();
    });
  });

  it('パンくずリストが表示されるべき', async () => {
    mockGetEventDetails.mockResolvedValue(battleData);
    mockGetLeaderboard.mockResolvedValue(leaderboardData);
    render(<BattleLeaderboardPage />);
    await waitFor(() => {
      const links = screen.getAllByRole('link');
      const battleListLink = links.find((l) => l.textContent === 'バトル一覧');
      expect(battleListLink).toBeDefined();
      expect(battleListLink).toHaveAttribute('href', '/battles');
    });
  });
});
