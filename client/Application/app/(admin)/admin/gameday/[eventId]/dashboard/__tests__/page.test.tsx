import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import AdminGameDayDashboardPage from '../page';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  useParams: () => ({ eventId: 'ev-1' }),
}));

const mockGameState = {
  eventId: 'ev-1',
  tenantId: 'tenant-1',
  isRunning: true,
  startedAt: new Date(Date.now() - 600000).toISOString(),
  scoreWeight: 'normal',
  blackout: false,
  durationMinutes: 60,
};

const mockLeaderboard = [
  {
    rank: 1,
    teamId: 'team-1',
    teamName: 'Alpha',
    score: 5000,
    attacksLaunched: 3,
    attacksReceived: 1,
    vulnerabilitiesFixed: 2,
  },
];

const mockAttackLogs = {
  logs: [
    {
      id: 'log-1',
      attackerTeamId: 'team-1',
      defenderTeamId: 'team-2',
      attackSlug: 'sql-injection',
      success: true,
      damage: 1000,
      createdAt: new Date().toISOString(),
    },
  ],
};

const mockAttackStats = {
  stats: [
    {
      attackSlug: 'sql-injection',
      attackName: 'SQL Injection',
      totalExecutions: 5,
      successRate: 0.8,
    },
  ],
};

function mockFetchSuccess() {
  vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    if (urlStr.includes('status')) {
      return Promise.resolve(new Response(JSON.stringify(mockGameState)));
    }
    if (urlStr.includes('leaderboard')) {
      return Promise.resolve(
        new Response(JSON.stringify({ leaderboard: mockLeaderboard })),
      );
    }
    if (urlStr.includes('attack-logs')) {
      return Promise.resolve(new Response(JSON.stringify(mockAttackLogs)));
    }
    if (urlStr.includes('attack-stats')) {
      return Promise.resolve(new Response(JSON.stringify(mockAttackStats)));
    }
    return Promise.resolve(new Response('{}'));
  });
}

describe('AdminGameDayDashboardPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('ローディング中はスピナーを表示すべき', () => {
    vi.spyOn(globalThis, 'fetch').mockReturnValue(new Promise(() => {}));
    render(<AdminGameDayDashboardPage />);
    expect(
      document.querySelector('[class*="spinner"]') ||
        document.querySelector('[class*="awsui_root"]'),
    ).toBeInTheDocument();
  });

  it('ダッシュボードタイトルを表示すべき', async () => {
    mockFetchSuccess();
    render(<AdminGameDayDashboardPage />);
    await waitFor(() => {
      expect(
        screen.getByText('リアルタイムダッシュボード'),
      ).toBeInTheDocument();
    });
  });

  it('ゲーム状態が稼働中と表示されるべき', async () => {
    mockFetchSuccess();
    render(<AdminGameDayDashboardPage />);
    await waitFor(() => {
      expect(screen.getByText('稼働中')).toBeInTheDocument();
    });
  });

  it('リーダーボードにチーム名が表示されるべき', async () => {
    mockFetchSuccess();
    render(<AdminGameDayDashboardPage />);
    await waitFor(() => {
      expect(screen.getByText('Alpha')).toBeInTheDocument();
    });
  });

  it('攻撃タイムラインに攻撃ログが表示されるべき', async () => {
    mockFetchSuccess();
    render(<AdminGameDayDashboardPage />);
    await waitFor(() => {
      expect(
        screen.getAllByText('sql-injection').length,
      ).toBeGreaterThanOrEqual(1);
    });
  });

  it('攻撃統計が表示されるべき', async () => {
    mockFetchSuccess();
    render(<AdminGameDayDashboardPage />);
    await waitFor(() => {
      expect(screen.getByText('SQL Injection')).toBeInTheDocument();
      expect(screen.getByText('80%')).toBeInTheDocument();
    });
  });

  it('エラー時にエラーメッセージを表示すべき', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('接続失敗'));
    render(<AdminGameDayDashboardPage />);
    await waitFor(() => {
      expect(screen.getByText('接続失敗')).toBeInTheDocument();
    });
  });

  it('ゲーム停止時に停止ステータスを表示すべき', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('status')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ...mockGameState,
              isRunning: false,
              startedAt: null,
            }),
          ),
        );
      }
      return Promise.resolve(new Response(JSON.stringify({})));
    });
    render(<AdminGameDayDashboardPage />);
    await waitFor(() => {
      expect(screen.getByText('停止')).toBeInTheDocument();
    });
  });
});
