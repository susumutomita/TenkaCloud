import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import ScoresPage from '../page';

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
const mockGetMyRanking = vi.fn();

vi.mock('@/lib/api/events', () => ({
  getEventDetails: (...args: unknown[]) => mockGetEventDetails(...args),
  getMyRanking: (...args: unknown[]) => mockGetMyRanking(...args),
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
  problemCount: 2,
  participantCount: 42,
  isRegistered: true,
  problems: [
    {
      id: 'prob-1',
      title: 'S3 バケット構築',
      type: 'gameday' as const,
      category: 'architecture' as const,
      difficulty: 'easy' as const,
      overview: 'S3 バケットを作成する課題',
      objectives: ['バケットを作成'],
      order: 1,
      isUnlocked: true,
      pointMultiplier: 1,
      maxScore: 100,
      myScore: 80,
      isCompleted: false,
    },
    {
      id: 'prob-2',
      title: 'VPC 構築',
      type: 'gameday' as const,
      category: 'security' as const,
      difficulty: 'medium' as const,
      overview: 'VPC を構築する課題',
      objectives: ['VPC を作成'],
      order: 2,
      isUnlocked: true,
      pointMultiplier: 1,
      maxScore: 200,
      myScore: 0,
      isCompleted: false,
    },
  ],
};

const rankingData = {
  rank: 3,
  totalScore: 80,
  problemScores: { 'prob-1': 80, 'prob-2': 0 },
};

describe('スコアページ', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ページタイトル「マイスコア」が表示されるべき', async () => {
    mockGetEventDetails.mockResolvedValue(battleData);
    mockGetMyRanking.mockResolvedValue(rankingData);
    render(<ScoresPage />);
    await waitFor(() => {
      expect(screen.getByText('マイスコア')).toBeInTheDocument();
    });
  });

  it('ローディングスピナーが初期表示されるべき', () => {
    mockGetEventDetails.mockReturnValue(new Promise(() => {}));
    mockGetMyRanking.mockReturnValue(new Promise(() => {}));
    render(<ScoresPage />);
    expect(document.querySelector('.animate-spin')).toBeInTheDocument();
  });

  it('合計スコアが表示されるべき', async () => {
    mockGetEventDetails.mockResolvedValue(battleData);
    mockGetMyRanking.mockResolvedValue(rankingData);
    render(<ScoresPage />);
    await waitFor(() => {
      expect(screen.getByText('合計スコア')).toBeInTheDocument();
    });
  });

  it('順位が表示されるべき', async () => {
    mockGetEventDetails.mockResolvedValue(battleData);
    mockGetMyRanking.mockResolvedValue(rankingData);
    render(<ScoresPage />);
    await waitFor(() => {
      expect(screen.getByText('#3')).toBeInTheDocument();
    });
  });

  it('問題別スコアが表示されるべき', async () => {
    mockGetEventDetails.mockResolvedValue(battleData);
    mockGetMyRanking.mockResolvedValue(rankingData);
    render(<ScoresPage />);
    await waitFor(() => {
      expect(screen.getByText('問題別スコア')).toBeInTheDocument();
      expect(screen.getByText('S3 バケット構築')).toBeInTheDocument();
      expect(screen.getByText('VPC 構築')).toBeInTheDocument();
    });
  });

  it('ポーリング中は更新中バッジが表示されるべき', async () => {
    mockGetEventDetails.mockResolvedValue(battleData);
    mockGetMyRanking.mockResolvedValue(rankingData);
    render(<ScoresPage />);
    await waitFor(() => {
      expect(screen.getByText('更新中')).toBeInTheDocument();
    });
  });

  it('リーダーボードへのリンクが表示されるべき', async () => {
    mockGetEventDetails.mockResolvedValue(battleData);
    mockGetMyRanking.mockResolvedValue(rankingData);
    render(<ScoresPage />);
    await waitFor(() => {
      expect(screen.getByText('リーダーボードを見る')).toBeInTheDocument();
    });
  });

  it('エラー時にエラー表示されるべき', async () => {
    mockGetEventDetails.mockRejectedValue(new Error('Network error'));
    mockGetMyRanking.mockRejectedValue(new Error('Network error'));
    render(<ScoresPage />);
    await waitFor(() => {
      expect(screen.getByText('再試行')).toBeInTheDocument();
    });
  });

  it('ポーリングでスコアを更新するべき', async () => {
    mockGetEventDetails.mockResolvedValue(battleData);
    mockGetMyRanking.mockResolvedValue(rankingData);
    render(<ScoresPage />);
    await waitFor(() => {
      expect(screen.getByText('マイスコア')).toBeInTheDocument();
    });
    expect(mockGetMyRanking).toHaveBeenCalled();
  });

  it('パンくずリストが表示されるべき', async () => {
    mockGetEventDetails.mockResolvedValue(battleData);
    mockGetMyRanking.mockResolvedValue(rankingData);
    render(<ScoresPage />);
    await waitFor(() => {
      const links = screen.getAllByRole('link');
      const battleListLink = links.find((l) => l.textContent === 'バトル一覧');
      expect(battleListLink).toBeDefined();
      expect(battleListLink).toHaveAttribute('href', '/battles');
    });
  });
});
