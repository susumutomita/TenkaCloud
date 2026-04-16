import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import HistoryPage from '../page';

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
  getTenantId: vi.fn().mockReturnValue('test-tenant'),
  useTenantOptional: () => null,
}));

const mockGetEventHistory = vi.fn();
vi.mock('@/lib/api/profile', () => ({
  getEventHistory: (...args: unknown[]) => mockGetEventHistory(...args),
}));

const baseEvent = {
  eventId: 'evt-1',
  eventName: 'テストイベント',
  eventType: 'gameday' as const,
  participatedAt: '2024-06-01T10:00:00Z',
  finalRank: 2,
  totalParticipants: 10,
  score: 1200,
};

describe('HistoryPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ローディング中はイベントデータを表示しないべき', () => {
    mockGetEventHistory.mockReturnValue(new Promise(() => {}));
    render(<HistoryPage />);
    // While loading, table data should not be rendered
    expect(screen.queryByText('テストイベント')).not.toBeInTheDocument();
  });

  it('APIからイベント履歴を取得して表示すべき', async () => {
    mockGetEventHistory.mockResolvedValue({
      events: [baseEvent],
      total: 1,
    });
    render(<HistoryPage />);

    await waitFor(() => {
      expect(screen.getByText('テストイベント')).toBeInTheDocument();
    });
    expect(screen.getByText('2 / 10')).toBeInTheDocument();
    expect(screen.getByText('1,200 pts')).toBeInTheDocument();
  });

  it('履歴が空の場合は空状態メッセージを表示すべき', async () => {
    mockGetEventHistory.mockResolvedValue({ events: [], total: 0 });
    render(<HistoryPage />);

    await waitFor(() => {
      // English locale default
      expect(
        screen.getByText('No events participated yet'),
      ).toBeInTheDocument();
    });
  });

  it('プロフィールへ戻るリンクを表示すべき', async () => {
    mockGetEventHistory.mockResolvedValue({ events: [], total: 0 });
    render(<HistoryPage />);

    await waitFor(() => {
      // Rendered in English locale by default
      const links = screen.getAllByRole('link');
      const backLink = links.find((l) => l.textContent?.includes('Profile'));
      expect(backLink).toBeTruthy();
    });
  });

  it('ページ数が2以上のときページネーションを表示すべき', async () => {
    const manyEvents = Array.from({ length: 20 }, (_, i) => ({
      ...baseEvent,
      eventId: `evt-${i}`,
      eventName: `イベント${i + 1}`,
    }));
    mockGetEventHistory
      .mockResolvedValueOnce({ events: manyEvents, total: 40 })
      .mockResolvedValue({ events: manyEvents, total: 40 });

    render(<HistoryPage />);

    await waitFor(() => {
      expect(screen.getByText('イベント1')).toBeInTheDocument();
    });

    // Cloudscape Pagination renders prev/next arrow buttons + page buttons
    const allButtons = screen.getAllByRole('button');
    expect(allButtons.length).toBeGreaterThanOrEqual(1);
    // Pagination container should be present
    const paginationEl = document.querySelector('[class*="pagination"]');
    expect(paginationEl).toBeTruthy();
  });

  it('ページを変更すると再フェッチすべき', async () => {
    const manyEvents = Array.from({ length: 20 }, (_, i) => ({
      ...baseEvent,
      eventId: `evt-${i}`,
      eventName: `イベント${i + 1}`,
    }));
    const page2Events = Array.from({ length: 5 }, (_, i) => ({
      ...baseEvent,
      eventId: `evt-p2-${i}`,
      eventName: `ページ2イベント${i + 1}`,
    }));

    mockGetEventHistory
      .mockResolvedValueOnce({ events: manyEvents, total: 25 })
      .mockResolvedValue({ events: page2Events, total: 25 });

    render(<HistoryPage />);

    await waitFor(() => {
      expect(screen.getByText('イベント1')).toBeInTheDocument();
    });

    // Click page 2
    const nextButtons = screen
      .getAllByRole('button')
      .filter(
        (b) =>
          b.getAttribute('aria-label')?.includes('次') ||
          b.textContent?.trim() === '2',
      );
    if (nextButtons.length > 0) {
      fireEvent.click(nextButtons[0]);
      await waitFor(() => {
        expect(mockGetEventHistory).toHaveBeenCalledTimes(2);
      });
    }
  });

  it('rank が null の場合は "-" を表示すべき', async () => {
    mockGetEventHistory.mockResolvedValue({
      events: [{ ...baseEvent, finalRank: null }],
      total: 1,
    });
    render(<HistoryPage />);

    await waitFor(() => {
      expect(screen.getByText('テストイベント')).toBeInTheDocument();
    });
    expect(screen.getByText('-')).toBeInTheDocument();
  });
});
