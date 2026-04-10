import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import AdminGamedayPage from '../page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: null, status: 'unauthenticated' }),
}));

vi.mock('@/lib/tenant', () => ({
  getTenantId: vi.fn().mockReturnValue('test-tenant'),
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

const baseGameState = {
  eventId: 'ev-1',
  isRunning: false,
  blackout: false,
  scoreWeight: 'normal' as const,
  durationMinutes: 60,
  startedAt: null,
};

const baseEvent = {
  id: 'ev-1',
  name: 'GameDay Test Event',
  type: 'gameday',
  status: 'active',
  startTime: '2024-06-01T10:00:00Z',
  participantCount: 20,
};

describe('AdminGamedayPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue({ events: [baseEvent] });
    mockGetGameStatus.mockResolvedValue(baseGameState);
  });

  it('ローディング中はイベントデータを表示しないべき', () => {
    mockGet.mockReturnValue(new Promise(() => {}));
    render(<AdminGamedayPage />);
    expect(screen.queryByText('GameDay Test Event')).not.toBeInTheDocument();
  });

  it('GameDay管理ページのタイトルを表示すべき', async () => {
    render(<AdminGamedayPage />);

    await waitFor(() => {
      expect(screen.getByText('GameDay 管理')).toBeInTheDocument();
    });
  });

  it('GameDayイベントを表示すべき', async () => {
    render(<AdminGamedayPage />);

    await waitFor(() => {
      expect(screen.getByText('GameDay Test Event')).toBeInTheDocument();
    });
  });

  it('GameDayタイプ以外のイベントをフィルタリングすべき', async () => {
    mockGet.mockResolvedValue({
      events: [
        baseEvent,
        { ...baseEvent, id: 'ev-2', name: 'JAM Event', type: 'jam' },
      ],
    });
    render(<AdminGamedayPage />);

    await waitFor(() => {
      expect(screen.getByText('GameDay Test Event')).toBeInTheDocument();
    });
    expect(screen.queryByText('JAM Event')).not.toBeInTheDocument();
  });

  it('イベントがない場合は空状態メッセージを表示すべき', async () => {
    mockGet.mockResolvedValue({ events: [] });
    render(<AdminGamedayPage />);

    await waitFor(() => {
      expect(
        screen.getByText('GameDay イベントがありません'),
      ).toBeInTheDocument();
    });
  });

  it('APIエラー時にエラー状態を表示すべき', async () => {
    mockGet.mockRejectedValue(new Error('API Error'));
    render(<AdminGamedayPage />);

    await waitFor(() => {
      expect(screen.getByText('API Error')).toBeInTheDocument();
    });
  });

  it('手動イベントID検索フォームを表示すべき', async () => {
    render(<AdminGamedayPage />);

    await waitFor(() => {
      expect(
        screen.getByText(/イベント ID を直接指定して GameDay 状態を確認します/),
      ).toBeInTheDocument();
    });
  });
});
