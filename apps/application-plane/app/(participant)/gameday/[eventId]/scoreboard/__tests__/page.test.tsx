import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import ScoreboardPage from '../page';

vi.mock('next/navigation', () => ({
  useParams: () => ({ eventId: 'ev-1' }),
}));

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: null, status: 'unauthenticated' }),
}));

vi.mock('@/lib/hooks/use-gameday-session', () => ({
  useGamedaySession: () => ({
    eventId: 'ev-1',
    teamId: 'team-1',
    teamName: 'TeamAlpha',
  }),
}));

const mockUseLeaderboardSSE = vi.fn();

vi.mock('@/lib/hooks/use-leaderboard-sse', () => ({
  useLeaderboardSSE: (...args: unknown[]) => mockUseLeaderboardSSE(...args),
}));

const mockGetAttackStats = vi.fn();

vi.mock('@/lib/api/gameday', () => ({
  getAttackStats: (...args: unknown[]) => mockGetAttackStats(...args),
}));

const baseSSEData = {
  eventId: 'ev-1',
  entries: [
    {
      rank: 1,
      teamId: 'team-2',
      teamName: 'TeamBeta',
      score: 1500,
    },
    {
      rank: 2,
      teamId: 'team-1',
      teamName: 'TeamAlpha',
      score: 1200,
    },
  ],
};

const baseAttackStats = [
  {
    attackSlug: 'sql-injection',
    attackName: 'SQL Injection',
    totalExecutions: 10,
    successRate: 0.7,
  },
];

describe('ScoreboardPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseLeaderboardSSE.mockReturnValue({
      data: baseSSEData,
      error: null,
      connected: true,
    });
    mockGetAttackStats.mockResolvedValue({ stats: baseAttackStats });
  });

  it('SSEデータ未受信時はリーダーボードデータを表示しないべき', () => {
    mockUseLeaderboardSSE.mockReturnValue({
      data: null,
      error: null,
      connected: false,
    });
    mockGetAttackStats.mockReturnValue(new Promise(() => {}));
    render(<ScoreboardPage />);
    expect(screen.queryByText('TeamBeta')).not.toBeInTheDocument();
  });

  it('リーダーボードのデータを表示すべき', async () => {
    render(<ScoreboardPage />);

    await waitFor(() => {
      expect(screen.getByText('TeamBeta')).toBeInTheDocument();
    });
    expect(screen.getByText('TeamAlpha')).toBeInTheDocument();
  });

  it('スコアボードタイトルを表示すべき', async () => {
    render(<ScoreboardPage />);

    await waitFor(() => {
      expect(screen.getByText('スコアボード')).toBeInTheDocument();
    });
  });

  it('攻撃統計を表示すべき', async () => {
    render(<ScoreboardPage />);

    await waitFor(() => {
      expect(screen.getByText('SQL Injection')).toBeInTheDocument();
    });
  });

  it('SSEエラー時にエラー状態を表示すべき', async () => {
    mockUseLeaderboardSSE.mockReturnValue({
      data: null,
      error: 'Server error',
      connected: false,
    });
    render(<ScoreboardPage />);

    await waitFor(() => {
      expect(screen.getByText('エラーが発生しました')).toBeInTheDocument();
    });
  });

  it('403エラー時にブラックアウト画面を表示すべき', async () => {
    const forbiddenError = Object.assign(new Error('Forbidden'), {
      status: 403,
    });
    mockGetAttackStats.mockRejectedValue(forbiddenError);
    render(<ScoreboardPage />);

    await waitFor(() => {
      expect(screen.getByText('BLACKOUT')).toBeInTheDocument();
    });
  });

  it('自チームのバッジを表示すべき', async () => {
    render(<ScoreboardPage />);

    await waitFor(() => {
      expect(screen.getByText('自チーム')).toBeInTheDocument();
    });
  });
});
