import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import BattlesPage from '../page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useParams: () => ({}),
}));

vi.mock('next-auth/react', () => ({
  SessionProvider: ({ children }: { children: React.ReactNode }) => children,
  useSession: () => ({ data: null, status: 'unauthenticated' }),
  getSession: vi.fn().mockResolvedValue(null),
}));

const mockGetAvailableEvents = vi.fn();
vi.mock('@/lib/api/events', () => ({
  getAvailableEvents: (...args: unknown[]) => mockGetAvailableEvents(...args),
}));

describe('バトル一覧ページ', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ページタイトル「バトル一覧」が表示されるべき', async () => {
    mockGetAvailableEvents.mockResolvedValue({ events: [], total: 0 });
    render(<BattlesPage />);
    await waitFor(() => {
      expect(screen.getByText('Battles')).toBeInTheDocument();
    });
  });

  it('ローディングスピナーが初期表示されるべき', () => {
    mockGetAvailableEvents.mockReturnValue(new Promise(() => {}));
    render(<BattlesPage />);
    // Cloudscape Cards shows loadingText while loading
    expect(screen.getByText('Loading events...')).toBeInTheDocument();
  });

  it('バトルが0件のとき空状態メッセージが表示されるべき', async () => {
    mockGetAvailableEvents.mockResolvedValue({ events: [], total: 0 });
    render(<BattlesPage />);
    await waitFor(() => {
      expect(screen.getByText('No battles found')).toBeInTheDocument();
    });
  });

  it('バトル一覧がカード形式で表示されるべき', async () => {
    mockGetAvailableEvents.mockResolvedValue({
      events: [
        {
          id: 'battle-1',
          name: 'AWS GameDay 2025',
          type: 'gameday',
          status: 'active',
          startTime: '2025-01-01T09:00:00Z',
          endTime: '2025-01-01T17:00:00Z',
          timezone: 'Asia/Tokyo',
          participantType: 'individual',
          cloudProvider: 'aws',
          regions: ['ap-northeast-1'],
          scoringType: 'realtime',
          leaderboardVisible: true,
          problemCount: 5,
          participantCount: 42,
          isRegistered: false,
        },
      ],
      total: 1,
    });

    render(<BattlesPage />);
    await waitFor(() => {
      expect(screen.getByText('AWS GameDay 2025')).toBeInTheDocument();
    });
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('Join now')).toBeInTheDocument();
  });

  it('登録済みバトルに「登録済み」バッジが表示されるべき', async () => {
    mockGetAvailableEvents.mockResolvedValue({
      events: [
        {
          id: 'battle-2',
          name: 'Security Jam',
          type: 'jam',
          status: 'active',
          startTime: '2025-01-01T09:00:00Z',
          endTime: '2025-01-01T17:00:00Z',
          timezone: 'Asia/Tokyo',
          participantType: 'individual',
          cloudProvider: 'aws',
          regions: ['ap-northeast-1'],
          scoringType: 'realtime',
          leaderboardVisible: true,
          problemCount: 3,
          participantCount: 20,
          isRegistered: true,
        },
      ],
      total: 1,
    });

    render(<BattlesPage />);
    await waitFor(() => {
      expect(screen.getByText('Registered')).toBeInTheDocument();
    });
  });

  it('エラー時にエラー表示されるべき', async () => {
    mockGetAvailableEvents.mockRejectedValue(new Error('Network error'));
    render(<BattlesPage />);
    await waitFor(() => {
      expect(screen.getByText('Retry')).toBeInTheDocument();
    });
  });

  it('ステータスフィルターが機能するべき', async () => {
    mockGetAvailableEvents.mockResolvedValue({ events: [], total: 0 });
    render(<BattlesPage />);

    await waitFor(() => {
      expect(screen.getByText('No battles found')).toBeInTheDocument();
    });

    // 初回ロード時にデフォルトフィルターでAPIが呼ばれることを確認
    expect(mockGetAvailableEvents).toHaveBeenCalledWith(
      expect.objectContaining({ status: ['scheduled', 'active'] }),
    );
  });

  it('タイプフィルターが機能するべき', async () => {
    mockGetAvailableEvents.mockResolvedValue({ events: [], total: 0 });
    render(<BattlesPage />);

    await waitFor(() => {
      expect(screen.getByText('No battles found')).toBeInTheDocument();
    });

    // 初回ロード時にタイプフィルターなしでAPIが呼ばれることを確認
    expect(mockGetAvailableEvents).toHaveBeenCalledWith(
      expect.objectContaining({ type: undefined }),
    );
  });
});
