import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import EventsPage from '../page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: null, status: 'unauthenticated' }),
}));

const mockGetAvailableEvents = vi.fn();
vi.mock('@/lib/api/events', () => ({
  getAvailableEvents: (...args: unknown[]) => mockGetAvailableEvents(...args),
}));

const sampleEvent = {
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
  isRegistered: false,
};

describe('イベント一覧ページ', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('カードビューでイベントが表示されるべき', async () => {
    mockGetAvailableEvents.mockResolvedValue({
      events: [sampleEvent],
      total: 1,
    });
    render(<EventsPage />);
    await waitFor(() => {
      expect(screen.getByText('AWS GameDay 2026')).toBeInTheDocument();
    });
  });

  it('カード/リスト/カレンダー切り替えボタンが表示されるべき', async () => {
    mockGetAvailableEvents.mockResolvedValue({ events: [], total: 0 });
    render(<EventsPage />);
    await waitFor(() => {
      // SegmentedControl renders each option; some may appear multiple times
      expect(screen.getAllByText('Cards').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('List').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('Calendar').length).toBeGreaterThanOrEqual(1);
    });
  });

  it('リストビューに切り替えるとテーブル形式で表示されるべき', async () => {
    mockGetAvailableEvents.mockResolvedValue({
      events: [sampleEvent],
      total: 1,
    });
    render(<EventsPage />);

    await waitFor(() => {
      expect(screen.getByText('List')).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByText('List'));

    await waitFor(() => {
      // リストビューではイベント名が表示される
      expect(screen.getByText('AWS GameDay 2026')).toBeInTheDocument();
    });
  });

  it('カレンダービューに切り替えると月が表示されるべき', async () => {
    mockGetAvailableEvents.mockResolvedValue({ events: [], total: 0 });
    render(<EventsPage />);

    await waitFor(() => {
      expect(screen.getByText('Calendar')).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByText('Calendar'));

    await waitFor(() => {
      // カレンダービューでは月ヘッダーが表示される（月/曜日）
      expect(screen.getByText('Mon')).toBeInTheDocument();
    });
  });

  it('カレンダービューで前月・翌月ナビゲーションができるべき', async () => {
    mockGetAvailableEvents.mockResolvedValue({ events: [], total: 0 });
    render(<EventsPage />);

    await waitFor(() => {
      expect(screen.getByText('Calendar')).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByText('Calendar'));

    await waitFor(() => {
      expect(screen.getByLabelText('Prev')).toBeInTheDocument();
      expect(screen.getByLabelText('Next')).toBeInTheDocument();
    });
  });

  it('イベントが0件のとき空状態が表示されるべき', async () => {
    mockGetAvailableEvents.mockResolvedValue({ events: [], total: 0 });
    render(<EventsPage />);
    await waitFor(() => {
      expect(screen.getByText('No events found')).toBeInTheDocument();
    });
  });

  it('登録済みイベントでは登録済みバッジが表示されるべき', async () => {
    mockGetAvailableEvents.mockResolvedValue({
      events: [{ ...sampleEvent, isRegistered: true }],
      total: 1,
    });
    render(<EventsPage />);
    await waitFor(() => {
      expect(screen.getByText('Registered')).toBeInTheDocument();
    });
  });

  it('参加者数がカードに表示されるべき', async () => {
    mockGetAvailableEvents.mockResolvedValue({
      events: [{ ...sampleEvent, participantCount: 42 }],
      total: 1,
    });
    render(<EventsPage />);
    await waitFor(() => {
      expect(screen.getByText('42')).toBeInTheDocument();
    });
  });
});
