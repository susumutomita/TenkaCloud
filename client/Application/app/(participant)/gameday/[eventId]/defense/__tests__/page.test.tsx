import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import DefensePage from '../page';

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

const mockGetActiveDefense = vi.fn();
const mockPurchaseHint = vi.fn();
const mockReportFix = vi.fn();

vi.mock('@/lib/api/gameday', () => ({
  getActiveDefense: (...args: unknown[]) => mockGetActiveDefense(...args),
  purchaseHint: (...args: unknown[]) => mockPurchaseHint(...args),
  reportFix: (...args: unknown[]) => mockReportFix(...args),
}));

const mockAddNotification = vi.fn();
vi.mock('@/lib/notifications', () => ({
  useNotifications: () => ({ addNotification: mockAddNotification }),
}));

const baseAttack = {
  attackId: 'atk-log-1',
  attackSlug: 'sql-injection',
  attackerTeamId: 'team-2',
  defenderTeamId: 'team-1',
  success: true,
  damage: 50,
  reward: 0,
  createdAt: '2024-06-01T10:00:00Z',
  neutralized: false,
};

describe('DefensePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetActiveDefense.mockResolvedValue({ attacks: [] });
  });

  it('ローディング中は攻撃データを表示しないべき', () => {
    mockGetActiveDefense.mockReturnValue(new Promise(() => {}));
    render(<DefensePage />);
    expect(screen.queryByText('sql-injection')).not.toBeInTheDocument();
  });

  it('防衛ページのヘッダーを表示すべき', async () => {
    render(<DefensePage />);

    await waitFor(() => {
      expect(screen.getByText('Defense Trench')).toBeInTheDocument();
    });
  });

  it('アクティブな攻撃を表示すべき', async () => {
    mockGetActiveDefense.mockResolvedValue({ attacks: [baseAttack] });
    render(<DefensePage />);

    await waitFor(() => {
      expect(screen.getByText('sql-injection')).toBeInTheDocument();
    });
    expect(screen.getByText('team-2')).toBeInTheDocument();
  });

  it('攻撃がない場合は空状態メッセージを表示すべき', async () => {
    render(<DefensePage />);

    await waitFor(() => {
      expect(
        screen.getByText('No active attacks right now.'),
      ).toBeInTheDocument();
    });
  });

  it('APIエラー時にエラーメッセージを表示すべき', async () => {
    mockGetActiveDefense.mockRejectedValue(new Error('読み込みに失敗しました'));
    render(<DefensePage />);

    await waitFor(() => {
      expect(screen.getByText('読み込みに失敗しました')).toBeInTheDocument();
    });
  });

  it('修正済み攻撃を別テーブルに表示すべき', async () => {
    const neutralizedAttack = { ...baseAttack, neutralized: true };
    mockGetActiveDefense.mockResolvedValue({
      attacks: [baseAttack, neutralizedAttack],
    });
    render(<DefensePage />);

    await waitFor(() => {
      // Mitigated table header (appears multiple times - header + cell content)
      const mitigated = screen.getAllByText('Mitigated');
      expect(mitigated.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('10秒ごとに自動更新する旨を表示すべき', async () => {
    render(<DefensePage />);

    await waitFor(() => {
      expect(
        screen.getByText('Refreshes every 10 seconds'),
      ).toBeInTheDocument();
    });
  });
});
