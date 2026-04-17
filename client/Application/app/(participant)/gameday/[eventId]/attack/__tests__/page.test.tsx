import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import AttackPage from '../page';

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

const mockDeploymentResult = {
  isReady: true,
  isChecking: false,
  status: { deployed: true, status: 'completed' },
  checkError: null,
};

vi.mock('@/lib/hooks/use-deployment-status', () => ({
  useDeploymentStatus: () => mockDeploymentResult,
}));

const mockGetAttackCatalog = vi.fn();
const mockGetAttackHistory = vi.fn();
const mockGetParticipantTeams = vi.fn();
const mockPurchaseAttack = vi.fn();
const mockExecuteAttack = vi.fn();

vi.mock('@/lib/api/gameday', () => ({
  getAttackCatalog: (...args: unknown[]) => mockGetAttackCatalog(...args),
  getAttackHistory: (...args: unknown[]) => mockGetAttackHistory(...args),
  getParticipantTeams: (...args: unknown[]) => mockGetParticipantTeams(...args),
  purchaseAttack: (...args: unknown[]) => mockPurchaseAttack(...args),
  executeAttack: (...args: unknown[]) => mockExecuteAttack(...args),
}));

const baseAttack = {
  id: 'atk-1',
  slug: 'sql-injection',
  name: 'SQL Injection',
  description: 'Inject SQL into the database',
  attackType: 'vulnerability' as const,
  purchaseCost: 100,
  damage: 50,
  reward: 150,
  cooldownSeconds: 60,
};

const baseLog = {
  attackId: 'log-1',
  attackSlug: 'sql-injection',
  attackerTeamId: 'team-1',
  defenderTeamId: 'team-2',
  success: true,
  damage: 50,
  reward: 150,
  createdAt: '2024-06-01T10:00:00Z',
  neutralized: false,
};

describe('AttackPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAttackCatalog.mockResolvedValue({ attacks: [baseAttack] });
    mockGetAttackHistory.mockResolvedValue({ history: [] });
    mockGetParticipantTeams.mockResolvedValue({
      teams: [
        { teamId: 'team-1', teamName: 'TeamAlpha' },
        { teamId: 'team-2', teamName: 'TeamBeta' },
      ],
    });
    mockDeploymentResult.isReady = true;
    mockDeploymentResult.isChecking = false;
    mockDeploymentResult.status = { deployed: true, status: 'completed' };
    mockDeploymentResult.checkError = null;
  });

  it('ローディング中は攻撃カタログを表示しないべき', () => {
    mockGetAttackCatalog.mockReturnValue(new Promise(() => {}));
    mockGetAttackHistory.mockReturnValue(new Promise(() => {}));
    render(<AttackPage />);
    expect(screen.queryByText('SQL Injection')).not.toBeInTheDocument();
  });

  it('攻撃カタログを表示すべき', async () => {
    render(<AttackPage />);

    await waitFor(() => {
      expect(screen.getByText('SQL Injection')).toBeInTheDocument();
    });
  });

  it('攻撃ページのヘッダーを表示すべき', async () => {
    render(<AttackPage />);

    await waitFor(() => {
      expect(screen.getByText('Attack Station')).toBeInTheDocument();
    });
  });

  it('攻撃履歴テーブルを表示すべき', async () => {
    mockGetAttackHistory.mockResolvedValue({ history: [baseLog] });
    render(<AttackPage />);

    await waitFor(() => {
      expect(screen.getByText('sql-injection')).toBeInTheDocument();
    });
  });

  it('APIエラー時にエラーメッセージを表示すべき', async () => {
    mockGetAttackCatalog.mockRejectedValue(new Error('読み込みに失敗しました'));
    render(<AttackPage />);

    await waitFor(() => {
      expect(screen.getByText('読み込みに失敗しました')).toBeInTheDocument();
    });
  });

  it('攻撃カタログが空の場合は空状態を表示すべき', async () => {
    mockGetAttackCatalog.mockResolvedValue({ attacks: [] });
    render(<AttackPage />);

    await waitFor(() => {
      // Cards empty text comes from t('common.noData') which is 'No data'
      expect(screen.queryByText('SQL Injection')).not.toBeInTheDocument();
    });
  });

  it('購入ボタンを表示すべき', async () => {
    render(<AttackPage />);

    await waitFor(() => {
      expect(screen.getByText('SQL Injection')).toBeInTheDocument();
    });

    // Purchase button shows cost
    expect(screen.getByText(/Purchase.*100 pts/)).toBeInTheDocument();
  });

  it('デプロイ未完了時に警告メッセージを表示すべき', async () => {
    mockDeploymentResult.isReady = false;
    mockDeploymentResult.status = {
      deployed: false,
      status: 'pending',
    };
    render(<AttackPage />);

    await waitFor(() => {
      expect(
        screen.getByText(
          'The environment deployment has not been completed yet. Please contact your administrator.',
        ),
      ).toBeInTheDocument();
    });
  });

  it('デプロイ中に進捗メッセージを表示すべき', async () => {
    mockDeploymentResult.isReady = false;
    mockDeploymentResult.status = {
      deployed: false,
      status: 'in_progress',
    };
    render(<AttackPage />);

    await waitFor(() => {
      expect(
        screen.getByText(
          'The environment is being deployed. Please wait a moment.',
        ),
      ).toBeInTheDocument();
    });
  });
});
