import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import AdminGameDayPage from '../page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useParams: () => ({}),
}));

vi.mock('next-auth/react', () => ({
  SessionProvider: ({ children }: { children: React.ReactNode }) => children,
  useSession: () => ({ data: null, status: 'unauthenticated' }),
  getSession: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/tenant', () => ({
  useTenantOptional: () => null,
}));

const mockGet = vi.fn();
vi.mock('@/lib/api/client', () => ({
  get: (...args: unknown[]) => mockGet(...args),
}));

const mockGetGameStatus = vi.fn();
vi.mock('@/lib/api/gameday-admin', () => ({
  getGameStatus: (...args: unknown[]) => mockGetGameStatus(...args),
}));

const baseEvent = {
  id: 'evt-gameday-1',
  name: 'テストGameDay',
  type: 'gameday',
  status: 'active',
  startTime: '2024-06-01T09:00:00Z',
  endTime: '2024-06-01T18:00:00Z',
  participantCount: 10,
  teamCount: 0,
  maxParticipants: 50,
};

const baseGameState = {
  eventId: 'evt-gameday-1',
  tenantId: 'tenant-1',
  isRunning: true,
  startedAt: '2024-06-01T09:00:00Z',
  scoreWeight: { attack: 1.0, defense: 1.0 },
  blackout: false,
  durationMinutes: 120,
};

describe('AdminGameDayPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ローディング中はデータを表示しないべき', () => {
    mockGet.mockReturnValue(new Promise(() => {}));
    render(<AdminGameDayPage />);
    expect(screen.queryByText('テストGameDay')).not.toBeInTheDocument();
  });

  it('GameDay管理ヘッダーを表示すべき', async () => {
    mockGet.mockResolvedValue({ events: [] });
    render(<AdminGameDayPage />);

    await waitFor(() => {
      expect(screen.getAllByText(/GameDay 管理/).length).toBeGreaterThanOrEqual(
        1,
      );
    });
  });

  it('GameDayイベント一覧を取得して表示すべき', async () => {
    mockGet.mockResolvedValue({ events: [baseEvent] });
    mockGetGameStatus.mockResolvedValue(baseGameState);
    render(<AdminGameDayPage />);

    await waitFor(() => {
      expect(
        screen.getAllByText('テストGameDay').length,
      ).toBeGreaterThanOrEqual(1);
    });
  });

  it('GameDayイベントが0件の場合は空状態メッセージを表示すべき', async () => {
    mockGet.mockResolvedValue({ events: [] });
    render(<AdminGameDayPage />);

    await waitFor(() => {
      expect(
        screen.getByText('GameDay イベントがありません'),
      ).toBeInTheDocument();
    });
  });

  it('GameDayでないイベントはフィルタリングすべき', async () => {
    mockGet.mockResolvedValue({
      events: [
        { ...baseEvent, id: 'jam-evt', name: 'JamEvent', type: 'jam' },
        baseEvent,
      ],
    });
    mockGetGameStatus.mockResolvedValue(baseGameState);
    render(<AdminGameDayPage />);

    await waitFor(() => {
      expect(
        screen.getAllByText('テストGameDay').length,
      ).toBeGreaterThanOrEqual(1);
    });
    expect(screen.queryByText('JamEvent')).not.toBeInTheDocument();
  });

  it('APIエラー時にエラー状態を表示すべき', async () => {
    mockGet.mockRejectedValue(new Error('サーバーエラー'));
    render(<AdminGameDayPage />);

    await waitFor(() => {
      // ErrorState component renders generic error title
      expect(screen.getByText('エラーが発生しました')).toBeInTheDocument();
    });
  });
});
