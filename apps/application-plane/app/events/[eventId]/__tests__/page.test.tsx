import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import EventDetailPage from '../page';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  useParams: () => ({ eventId: 'ev-1' }),
}));

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: null, status: 'unauthenticated' }),
}));

const mockGetEventDetails = vi.fn();
const mockGetLeaderboard = vi.fn();
const mockRegisterForEvent = vi.fn();

vi.mock('@/lib/api/events', () => ({
  getEventDetails: (...args: unknown[]) => mockGetEventDetails(...args),
  getLeaderboard: (...args: unknown[]) => mockGetLeaderboard(...args),
  registerForEvent: (...args: unknown[]) => mockRegisterForEvent(...args),
}));

const baseEvent = {
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
  problemCount: 0,
  participantCount: 10,
  isRegistered: true,
  problems: [],
  description: 'テストイベントの説明',
};

describe('イベント詳細ページ', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetLeaderboard.mockResolvedValue({ entries: [], updatedAt: '' });
  });

  it('イベント名が表示されるべき', async () => {
    mockGetEventDetails.mockResolvedValue(baseEvent);
    render(<EventDetailPage />);
    await waitFor(() => {
      expect(
        screen.getAllByText('AWS GameDay 2026').length,
      ).toBeGreaterThanOrEqual(1);
    });
  });

  it('問題が0件のアクティブイベントでは「まだ問題が登録されていません」と表示されるべき', async () => {
    mockGetEventDetails.mockResolvedValue({
      ...baseEvent,
      status: 'active',
      problems: [],
    });
    render(<EventDetailPage />);
    await waitFor(() => {
      expect(
        screen.getByText('まだ問題が登録されていません'),
      ).toBeInTheDocument();
    });
    expect(screen.queryByText('問題の読み込み中...')).not.toBeInTheDocument();
  });

  it('問題が0件の未開催イベントでは「問題はイベント開始時に公開されます」と表示されるべき', async () => {
    mockGetEventDetails.mockResolvedValue({
      ...baseEvent,
      status: 'scheduled',
      problems: [],
    });
    render(<EventDetailPage />);
    await waitFor(() => {
      expect(
        screen.getByText('問題はイベント開始時に公開されます'),
      ).toBeInTheDocument();
    });
  });

  it('ローディング中はイベント名が表示されないべき', () => {
    mockGetEventDetails.mockReturnValue(new Promise(() => {}));
    mockGetLeaderboard.mockReturnValue(new Promise(() => {}));
    render(<EventDetailPage />);
    expect(screen.queryByText('AWS GameDay 2026')).not.toBeInTheDocument();
  });

  it('未登録の場合は参加登録ボタンが表示されるべき', async () => {
    mockGetEventDetails.mockResolvedValue({
      ...baseEvent,
      status: 'scheduled',
      isRegistered: false,
      participantType: 'individual',
    });
    render(<EventDetailPage />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /参加登録/ })).toBeInTheDocument();
    });
  });

  it('登録済みの場合は登録済みバッジが表示されるべき', async () => {
    mockGetEventDetails.mockResolvedValue({
      ...baseEvent,
      isRegistered: true,
    });
    render(<EventDetailPage />);
    await waitFor(() => {
      expect(screen.getByText('登録済み')).toBeInTheDocument();
    });
  });

  it('チームイベントではチームで登録ボタンが表示されるべき', async () => {
    mockGetEventDetails.mockResolvedValue({
      ...baseEvent,
      status: 'scheduled',
      isRegistered: false,
      participantType: 'team',
    });
    render(<EventDetailPage />);
    await waitFor(() => {
      expect(screen.getByText('チームで登録')).toBeInTheDocument();
    });
  });

  it('参加者数が表示されるべき', async () => {
    mockGetEventDetails.mockResolvedValue({
      ...baseEvent,
      participantCount: 10,
    });
    render(<EventDetailPage />);
    await waitFor(() => {
      expect(screen.getByText('10人')).toBeInTheDocument();
    });
  });

  it('登録済みかつアクティブイベントではバトルに参加ボタンが表示されるべき', async () => {
    mockGetEventDetails.mockResolvedValue({
      ...baseEvent,
      status: 'active',
      isRegistered: true,
    });
    render(<EventDetailPage />);
    await waitFor(() => {
      expect(screen.getByText('バトルに参加')).toBeInTheDocument();
    });
  });

  it('完了済みイベントでは参加登録ボタンが表示されないべき', async () => {
    mockGetEventDetails.mockResolvedValue({
      ...baseEvent,
      status: 'completed',
      isRegistered: false,
    });
    render(<EventDetailPage />);
    await waitFor(() => {
      expect(
        screen.getAllByText('AWS GameDay 2026').length,
      ).toBeGreaterThanOrEqual(1);
    });
    expect(screen.queryByRole('button', { name: /参加登録/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /チームで登録/ })).not.toBeInTheDocument();
  });
});
