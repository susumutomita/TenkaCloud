import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import AdminGamedayControlPage from '../page';

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
const mockGetAttackLogs = vi.fn();
const mockStartGame = vi.fn();
const mockStopGame = vi.fn();
const mockToggleBlackout = vi.fn();
const mockToggleScoreWeight = vi.fn();
const mockRegisterTeam = vi.fn();
const mockSeedAttacks = vi.fn();
const mockStartAuditor = vi.fn();
const mockStopAuditor = vi.fn();
const mockExecuteFaultInjection = vi.fn();

vi.mock('@/lib/api/gameday-admin', () => ({
  getGameStatus: (...args: unknown[]) => mockGetGameStatus(...args),
  getTeams: (...args: unknown[]) => mockGetTeams(...args),
  getAttackLogs: (...args: unknown[]) => mockGetAttackLogs(...args),
  startGame: (...args: unknown[]) => mockStartGame(...args),
  stopGame: (...args: unknown[]) => mockStopGame(...args),
  toggleBlackout: (...args: unknown[]) => mockToggleBlackout(...args),
  toggleScoreWeight: (...args: unknown[]) => mockToggleScoreWeight(...args),
  registerTeam: (...args: unknown[]) => mockRegisterTeam(...args),
  seedAttacks: (...args: unknown[]) => mockSeedAttacks(...args),
  startAuditor: (...args: unknown[]) => mockStartAuditor(...args),
  stopAuditor: (...args: unknown[]) => mockStopAuditor(...args),
  executeFaultInjection: (...args: unknown[]) =>
    mockExecuteFaultInjection(...args),
}));

const mockGetAttackCatalog = vi.fn();
vi.mock('@/lib/api/gameday', () => ({
  getAttackCatalog: (...args: unknown[]) => mockGetAttackCatalog(...args),
}));

const baseGameState = {
  eventId: 'ev-1',
  isRunning: false,
  blackout: false,
  scoreWeight: 'normal' as const,
  durationMinutes: 60,
  startedAt: null,
};

describe('AdminGamedayControlPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetGameStatus.mockResolvedValue(baseGameState);
    mockGetTeams.mockResolvedValue({ teams: [] });
    mockGetAttackLogs.mockResolvedValue({ logs: [] });
    mockGetAttackCatalog.mockResolvedValue({ attacks: [] });
  });

  it('ローディング中はコントロールパネルを表示しないべき', () => {
    mockGetGameStatus.mockReturnValue(new Promise(() => {}));
    render(<AdminGamedayControlPage />);
    expect(
      screen.queryByText('GameDay コントロールパネル'),
    ).not.toBeInTheDocument();
  });

  it('コントロールパネルのヘッダーを表示すべき', async () => {
    render(<AdminGamedayControlPage />);

    await waitFor(() => {
      expect(
        screen.getByText('GameDay コントロールパネル'),
      ).toBeInTheDocument();
    });
  });

  it('ゲーム制御タブを表示すべき', async () => {
    render(<AdminGamedayControlPage />);

    await waitFor(() => {
      const elements = screen.getAllByText('ゲーム制御');
      expect(elements.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('停止状態のゲームにゲーム開始ボタンを表示すべき', async () => {
    render(<AdminGamedayControlPage />);

    await waitFor(() => {
      expect(screen.getByText('ゲーム開始')).toBeInTheDocument();
    });
  });

  it('稼働中ゲームにゲーム停止ボタンを表示すべき', async () => {
    mockGetGameStatus.mockResolvedValue({
      ...baseGameState,
      isRunning: true,
      startedAt: new Date().toISOString(),
    });
    render(<AdminGamedayControlPage />);

    await waitFor(() => {
      expect(screen.getByText('ゲーム停止')).toBeInTheDocument();
    });
  });

  it('APIエラー時にエラーメッセージを表示すべき', async () => {
    mockGetGameStatus.mockRejectedValue(new Error('読み込みに失敗しました'));
    render(<AdminGamedayControlPage />);

    await waitFor(() => {
      expect(screen.getByText('読み込みに失敗しました')).toBeInTheDocument();
    });
  });

  it('チームタブにチーム登録フォームを表示すべき', async () => {
    render(<AdminGamedayControlPage />);

    await waitFor(() => {
      expect(screen.getByText('チーム管理')).toBeInTheDocument();
    });
  });

  it('イベントIDをヘッダーに表示すべき', async () => {
    render(<AdminGamedayControlPage />);

    await waitFor(() => {
      expect(screen.getByText(/イベント ID: ev-1/)).toBeInTheDocument();
    });
  });

  describe('開始前チェックリスト', () => {
    it('チェックリスト項目を表示すべき', async () => {
      render(<AdminGamedayControlPage />);

      await waitFor(() => {
        expect(screen.getByText('開始前チェックリスト')).toBeInTheDocument();
      });
    });

    it('チェック項目がすべて失敗の場合ゲーム開始ボタンを無効にすべき', async () => {
      mockGetGameStatus.mockResolvedValue(baseGameState);
      mockGetTeams.mockResolvedValue({ teams: [] });
      mockGetAttackCatalog.mockResolvedValue({ attacks: [] });
      render(<AdminGamedayControlPage />);

      await waitFor(() => {
        expect(screen.getByText('ゲーム開始')).toBeInTheDocument();
      });

      const startButton = screen.getByText('ゲーム開始').closest('button');
      expect(startButton).toBeDisabled();
    });

    it('チーム不足の場合エラー表示すべき', async () => {
      mockGetTeams.mockResolvedValue({
        teams: [{ teamId: 't1', teamName: 'Team 1', eventId: 'ev-1' }],
      });
      render(<AdminGamedayControlPage />);

      await waitFor(() => {
        expect(
          screen.getByText(
            'チームが2チーム以上必要です（チーム管理タブで登録）',
          ),
        ).toBeInTheDocument();
      });
    });

    it('攻撃カタログ未登録の場合エラー表示すべき', async () => {
      mockGetAttackCatalog.mockResolvedValue({ attacks: [] });
      render(<AdminGamedayControlPage />);

      await waitFor(() => {
        expect(
          screen.getByText('攻撃カタログが未登録です（攻撃管理タブで生成）'),
        ).toBeInTheDocument();
      });
    });

    it('すべてのチェックが通った場合ゲーム開始ボタンを有効にすべき', async () => {
      mockGetGameStatus.mockResolvedValue(baseGameState);
      mockGetTeams.mockResolvedValue({
        teams: [
          { teamId: 't1', teamName: 'Team 1', eventId: 'ev-1' },
          { teamId: 't2', teamName: 'Team 2', eventId: 'ev-1' },
        ],
      });
      mockGetAttackCatalog.mockResolvedValue({
        attacks: [
          {
            id: 'a1',
            name: 'Attack 1',
            slug: 'attack-1',
            attackType: 'vulnerability',
            targetVulnerability: null,
            description: 'desc',
            purchaseCost: 10,
            damage: 5,
            reward: 3,
            cooldownSeconds: 60,
            defenseHint: 'hint',
            hintCost: 5,
          },
        ],
      });
      render(<AdminGamedayControlPage />);

      await waitFor(() => {
        expect(screen.getByText('ゲーム開始')).toBeInTheDocument();
      });

      const startButton = screen.getByText('ゲーム開始').closest('button');
      expect(startButton).not.toBeDisabled();
    });

    it('チェック未達の場合警告アラートを表示すべき', async () => {
      mockGetTeams.mockResolvedValue({ teams: [] });
      render(<AdminGamedayControlPage />);

      await waitFor(() => {
        expect(
          screen.getByText(
            'すべてのチェック項目を満たすまでゲームを開始できません',
          ),
        ).toBeInTheDocument();
      });
    });

    it('すべてのチェックが通った場合警告アラートを非表示にすべき', async () => {
      mockGetGameStatus.mockResolvedValue(baseGameState);
      mockGetTeams.mockResolvedValue({
        teams: [
          { teamId: 't1', teamName: 'Team 1', eventId: 'ev-1' },
          { teamId: 't2', teamName: 'Team 2', eventId: 'ev-1' },
        ],
      });
      mockGetAttackCatalog.mockResolvedValue({
        attacks: [
          {
            id: 'a1',
            name: 'Attack 1',
            slug: 'attack-1',
            attackType: 'vulnerability',
            targetVulnerability: null,
            description: 'desc',
            purchaseCost: 10,
            damage: 5,
            reward: 3,
            cooldownSeconds: 60,
            defenseHint: 'hint',
            hintCost: 5,
          },
        ],
      });
      render(<AdminGamedayControlPage />);

      await waitFor(() => {
        expect(screen.getByText('開始前チェックリスト')).toBeInTheDocument();
      });

      expect(
        screen.queryByText(
          'すべてのチェック項目を満たすまでゲームを開始できません',
        ),
      ).not.toBeInTheDocument();
    });
  });
});
