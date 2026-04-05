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

const mockGetLeaderboard = vi.fn();
const mockGetAttackStats = vi.fn();

vi.mock('@/lib/api/gameday', () => ({
  getLeaderboard: (...args: unknown[]) => mockGetLeaderboard(...args),
  getAttackStats: (...args: unknown[]) => mockGetAttackStats(...args),
}));

const baseLeaderboard = [
  {
    rank: 1,
    teamId: 'team-2',
    teamName: 'TeamBeta',
    score: 1500,
    attacksLaunched: 5,
    attacksReceived: 2,
    vulnerabilitiesFixed: 3,
  },
  {
    rank: 2,
    teamId: 'team-1',
    teamName: 'TeamAlpha',
    score: 1200,
    attacksLaunched: 3,
    attacksReceived: 4,
    vulnerabilitiesFixed: 2,
  },
];

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
    mockGetLeaderboard.mockResolvedValue({ leaderboard: baseLeaderboard });
    mockGetAttackStats.mockResolvedValue({ stats: baseAttackStats });
  });

  it('ローディング中はリーダーボードデータを表示しないべき', () => {
    mockGetLeaderboard.mockReturnValue(new Promise(() => {}));
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

  it('APIエラー時にエラー状態を表示すべき', async () => {
    mockGetLeaderboard.mockRejectedValue(new Error('Server error'));
    render(<ScoreboardPage />);

    await waitFor(() => {
      // ErrorState renders a title
      expect(screen.getByText('エラーが発生しました')).toBeInTheDocument();
    });
  });

  it('403エラー時にブラックアウト画面を表示すべき', async () => {
    const forbiddenError = Object.assign(new Error('Forbidden'), {
      status: 403,
    });
    mockGetLeaderboard.mockRejectedValue(forbiddenError);
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
