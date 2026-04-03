import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import BattleDetailPage from '../page';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  useParams: () => ({ id: 'battle-1' }),
}));

vi.mock('next-auth/react', () => ({
  SessionProvider: ({ children }: { children: React.ReactNode }) => children,
  useSession: () => ({ data: null, status: 'unauthenticated' }),
  getSession: vi.fn().mockResolvedValue(null),
}));

const mockGetEventDetails = vi.fn();
const mockGetLeaderboard = vi.fn();
const mockRegisterForEvent = vi.fn();

vi.mock('@/lib/api/events', () => ({
  getEventDetails: (...args: unknown[]) => mockGetEventDetails(...args),
  getLeaderboard: (...args: unknown[]) => mockGetLeaderboard(...args),
  registerForEvent: (...args: unknown[]) => mockRegisterForEvent(...args),
}));

const baseBattle = {
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
      isCompleted: false,
    },
  ],
};

describe('バトル詳細ページ', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetLeaderboard.mockResolvedValue(null);
  });

  it('バトル名が表示されるべき', async () => {
    mockGetEventDetails.mockResolvedValue(baseBattle);
    render(<BattleDetailPage />);
    await waitFor(() => {
      // Battle name appears in breadcrumb, h1, and container header
      expect(
        screen.getAllByText('AWS GameDay 2025').length,
      ).toBeGreaterThanOrEqual(1);
    });
  });

  it('ローディングスピナーが初期表示されるべき', () => {
    mockGetEventDetails.mockReturnValue(new Promise(() => {}));
    mockGetLeaderboard.mockReturnValue(new Promise(() => {}));
    render(<BattleDetailPage />);
    // Cloudscape Spinner renders — event name is not shown while loading
    expect(screen.queryByText('AWS GameDay 2025')).not.toBeInTheDocument();
  });

  it('バトルが見つからない場合にリダイレクトすべき', async () => {
    mockGetEventDetails.mockResolvedValue(null);
    render(<BattleDetailPage />);
    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/battles');
    });
  });

  it('エラー時にエラーメッセージが表示されるべき', async () => {
    mockGetEventDetails.mockRejectedValue(new Error('Server error'));
    render(<BattleDetailPage />);
    await waitFor(() => {
      expect(screen.getByText('← Back to battles')).toBeInTheDocument();
    });
  });

  it('アクティブなバトルの問題一覧が表示されるべき', async () => {
    mockGetEventDetails.mockResolvedValue(baseBattle);
    render(<BattleDetailPage />);
    await waitFor(() => {
      expect(screen.getByText('S3 バケット構築')).toBeInTheDocument();
    });
  });

  it('未登録ユーザーに参加登録ボタンが表示されるべき', async () => {
    mockGetEventDetails.mockResolvedValue({
      ...baseBattle,
      isRegistered: false,
      status: 'scheduled',
    });
    render(<BattleDetailPage />);
    await waitFor(() => {
      expect(screen.getByText('Register')).toBeInTheDocument();
    });
  });

  it('参加登録ボタンをクリックするとAPI呼び出しすべき', async () => {
    mockGetEventDetails.mockResolvedValue({
      ...baseBattle,
      isRegistered: false,
      status: 'scheduled',
    });
    mockRegisterForEvent.mockResolvedValue({ success: true, message: 'OK' });

    render(<BattleDetailPage />);
    await waitFor(() => {
      expect(screen.getByText('Register')).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByText('Register'));
    await waitFor(() => {
      expect(mockRegisterForEvent).toHaveBeenCalledWith('battle-1');
    });
  });

  it('登録済みユーザーにスコアとリーダーボードリンクが表示されるべき', async () => {
    mockGetEventDetails.mockResolvedValue(baseBattle);
    render(<BattleDetailPage />);
    await waitFor(() => {
      expect(screen.getByText('View scores')).toBeInTheDocument();
      expect(screen.getByText('Leaderboard')).toBeInTheDocument();
    });
  });

  it('パンくずリストにバトル一覧リンクが表示されるべき', async () => {
    mockGetEventDetails.mockResolvedValue(baseBattle);
    render(<BattleDetailPage />);
    await waitFor(() => {
      // BreadcrumbGroup renders battles.title ('Battles') as the first breadcrumb link
      expect(screen.getAllByText('Battles').length).toBeGreaterThanOrEqual(1);
    });
  });

  it('参加者情報が表示されるべき', async () => {
    mockGetEventDetails.mockResolvedValue(baseBattle);
    render(<BattleDetailPage />);
    await waitFor(() => {
      // KeyValuePairs renders participantCount as its value ('42')
      expect(screen.getByText('42')).toBeInTheDocument();
    });
  });
});
