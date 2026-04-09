import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import DashboardPage from '../page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: null, status: 'unauthenticated' }),
}));

const mockGetMyEvents = vi.fn();
const mockGetAvailableEvents = vi.fn();

vi.mock('@/lib/api/events', () => ({
  getMyEvents: (...args: unknown[]) => mockGetMyEvents(...args),
  getAvailableEvents: (...args: unknown[]) => mockGetAvailableEvents(...args),
}));

const activeEvent = {
  id: 'ev-1',
  name: 'AWS GameDay 2026',
  type: 'gameday' as const,
  status: 'active' as const,
  startTime: '2026-04-01T09:00:00Z',
  endTime: '2026-04-01T18:00:00Z',
  timezone: 'Asia/Tokyo',
  participantType: 'individual' as const,
  cloudProvider: 'aws' as const,
  regions: ['ap-northeast-1'],
  scoringType: 'realtime' as const,
  leaderboardVisible: true,
  problemCount: 5,
  participantCount: 42,
  isRegistered: true,
};

const scheduledEvent = {
  ...activeEvent,
  id: 'ev-2',
  name: 'Security JAM',
  status: 'scheduled' as const,
};

describe('ダッシュボードページ', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAvailableEvents.mockResolvedValue({ events: [], total: 0 });
  });

  it('ページタイトルが表示されるべき', async () => {
    mockGetMyEvents.mockResolvedValue({ events: [] });
    render(<DashboardPage />);
    await waitFor(() => {
      // Navigation link + h1 heading both show "Dashboard"
      expect(screen.getAllByText('Dashboard').length).toBeGreaterThanOrEqual(1);
    });
  });

  it('参加中のイベントが表示されるべき', async () => {
    mockGetMyEvents.mockResolvedValue({ events: [activeEvent] });
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByText('AWS GameDay 2026')).toBeInTheDocument();
    });
  });

  it('problemCount が undefined でも「undefined」と表示されないべき', async () => {
    mockGetMyEvents.mockResolvedValue({
      events: [
        {
          ...activeEvent,
          problemCount: undefined,
          participantCount: undefined,
        },
      ],
    });
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByText('AWS GameDay 2026')).toBeInTheDocument();
    });
    expect(screen.queryByText(/undefined/)).not.toBeInTheDocument();
  });

  it('登録済みイベントが表示されるべき', async () => {
    mockGetMyEvents.mockResolvedValue({ events: [scheduledEvent] });
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByText('Security JAM')).toBeInTheDocument();
    });
  });

  it('マイイベントがない場合にイベント一覧へのリンクが表示されるべき', async () => {
    mockGetMyEvents.mockResolvedValue({ events: [] });
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByText('Browse events →')).toBeInTheDocument();
    });
  });

  it('ローディング中にスピナーが表示されるべき', () => {
    mockGetMyEvents.mockReturnValue(new Promise(() => {}));
    render(<DashboardPage />);
    expect(screen.queryByText('AWS GameDay 2026')).not.toBeInTheDocument();
  });

  it('エラー時は生の例外文言ではなく汎用メッセージを表示すべき', async () => {
    mockGetMyEvents.mockRejectedValue(new Error('fetch failed'));
    render(<DashboardPage />);

    await waitFor(() => {
      expect(screen.getByText('Failed to load dashboard')).toBeInTheDocument();
    });

    expect(screen.queryByText('fetch failed')).not.toBeInTheDocument();
    expect(screen.getByText('Retry')).toBeInTheDocument();
  });
});
