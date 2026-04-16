import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import GameDayReportPage from '../page';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  useParams: () => ({ eventId: 'ev-1' }),
}));

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: null, status: 'unauthenticated' }),
}));

vi.mock('@/lib/tenant', () => ({
  getTenantId: vi.fn().mockReturnValue('test-tenant'),
  useTenantOptional: () => null,
}));

const mockGetGameStatus = vi.fn();
const mockGetTeams = vi.fn();

vi.mock('@/lib/api/gameday-admin', () => ({
  getGameStatus: (...args: unknown[]) => mockGetGameStatus(...args),
  getTeams: (...args: unknown[]) => mockGetTeams(...args),
}));

const mockGamedayRequest = vi.fn();
vi.mock('@/lib/api/gameday', () => ({
  gamedayRequest: (...args: unknown[]) => mockGamedayRequest(...args),
}));

const baseGameState = {
  eventId: 'ev-1',
  tenantId: 'test-tenant',
  isRunning: false,
  blackout: false,
  scoreWeight: 'normal' as const,
  durationMinutes: 60,
  startedAt: '2026-04-06T10:00:00Z',
};

const sampleLeaderboard = [
  {
    teamId: 'team-1',
    teamName: 'Alpha',
    score: 500,
    rank: 1,
    attacksLaunched: 10,
    attacksReceived: 3,
    vulnerabilitiesFixed: 5,
  },
  {
    teamId: 'team-2',
    teamName: 'Bravo',
    score: 300,
    rank: 2,
    attacksLaunched: 7,
    attacksReceived: 5,
    vulnerabilitiesFixed: 2,
  },
];

const sampleAttackStats = [
  {
    attackSlug: 'sql-injection',
    attackName: 'SQL Injection',
    totalExecutions: 15,
    successRate: 0.8,
  },
  {
    attackSlug: 'xss',
    attackName: 'Cross-Site Scripting',
    totalExecutions: 10,
    successRate: 0.6,
  },
];

describe('GameDayReportPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetGameStatus.mockResolvedValue(baseGameState);
    mockGetTeams.mockResolvedValue({
      teams: [
        { eventId: 'ev-1', teamId: 'team-1', teamName: 'Alpha' },
        { eventId: 'ev-1', teamId: 'team-2', teamName: 'Bravo' },
      ],
    });
    mockGamedayRequest.mockImplementation((endpoint: string) => {
      if (endpoint === '/dashboard/leaderboard') {
        return Promise.resolve({ leaderboard: sampleLeaderboard });
      }
      if (endpoint === '/dashboard/attack-stats') {
        return Promise.resolve({ stats: sampleAttackStats });
      }
      return Promise.reject(new Error('Unknown endpoint'));
    });
  });

  it('レポートタイトルを表示すべき', async () => {
    render(<GameDayReportPage />);

    await waitFor(() => {
      expect(screen.getByText('GameDay レポート')).toBeInTheDocument();
    });
  });

  it('イベントIDを表示すべき', async () => {
    render(<GameDayReportPage />);

    await waitFor(() => {
      expect(screen.getByText(/イベント ID: ev-1/)).toBeInTheDocument();
    });
  });

  it('ランキングテーブルを表示すべき', async () => {
    render(<GameDayReportPage />);

    await waitFor(() => {
      expect(screen.getByText('最終ランキング')).toBeInTheDocument();
      expect(screen.getByText(/\(2\)/)).toBeInTheDocument();
    });
  });

  it('攻撃統計を表示すべき', async () => {
    render(<GameDayReportPage />);

    await waitFor(() => {
      expect(screen.getByText('攻撃使用回数ランキング')).toBeInTheDocument();
      expect(screen.getByText('攻撃成功率ランキング')).toBeInTheDocument();
      expect(
        screen.getAllByText('SQL Injection').length,
      ).toBeGreaterThanOrEqual(1);
      expect(
        screen.getAllByText('Cross-Site Scripting').length,
      ).toBeGreaterThanOrEqual(1);
    });
  });

  it('CSVダウンロードボタンが存在すべき', async () => {
    render(<GameDayReportPage />);

    await waitFor(() => {
      const buttons = screen.getAllByText('CSV ダウンロード');
      expect(buttons.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('ローディング中はスピナーを表示すべき', () => {
    mockGetGameStatus.mockReturnValue(new Promise(() => {}));
    render(<GameDayReportPage />);
    expect(screen.queryByText('GameDay レポート')).not.toBeInTheDocument();
  });

  it('APIエラー時にエラーメッセージを表示すべき', async () => {
    mockGetGameStatus.mockRejectedValue(
      new Error('レポートの取得に失敗しました'),
    );
    render(<GameDayReportPage />);

    await waitFor(() => {
      expect(
        screen.getByText('レポートの取得に失敗しました'),
      ).toBeInTheDocument();
    });
  });

  it('イベント概要セクションを表示すべき', async () => {
    render(<GameDayReportPage />);

    await waitFor(() => {
      expect(screen.getByText('イベント概要')).toBeInTheDocument();
    });
  });

  it('チームパフォーマンスサマリーを表示すべき', async () => {
    render(<GameDayReportPage />);

    await waitFor(() => {
      expect(
        screen.getByText('チームパフォーマンスサマリー'),
      ).toBeInTheDocument();
    });
  });

  it('コントロールパネルに戻るボタンが存在すべき', async () => {
    render(<GameDayReportPage />);

    await waitFor(() => {
      expect(screen.getByText('コントロールパネルに戻る')).toBeInTheDocument();
    });
  });
});
