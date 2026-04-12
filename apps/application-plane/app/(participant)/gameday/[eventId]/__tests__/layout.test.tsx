import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import GamedayLayout from '../layout';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  usePathname: () => '/gameday/ev-1',
}));

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: null, status: 'unauthenticated' }),
  signOut: vi.fn(),
}));

vi.mock('@/lib/hooks/use-gameday-session', () => ({
  useGamedaySession: () => ({
    eventId: 'ev-1',
    teamId: 'team-1',
    teamName: 'TeamAlpha',
  }),
}));

vi.mock('@/lib/api/gameday', () => ({
  getParticipantGameStatus: vi.fn().mockResolvedValue(null),
  getTeamDashboard: vi.fn().mockResolvedValue(null),
  getLeaderboard: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/components/notifications/notification-panel', () => ({
  NotificationPanel: () => <div data-testid="notification-panel" />,
}));

describe('GamedayLayout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('TenkaCloud ロゴが表示されるべき', async () => {
    render(<GamedayLayout>content</GamedayLayout>);
    await waitFor(() => {
      expect(screen.getAllByText('TenkaCloud').length).toBeGreaterThanOrEqual(
        1,
      );
    });
  });

  it('トップナビゲーションコンテナが表示されるべき', async () => {
    render(<GamedayLayout>content</GamedayLayout>);
    await waitFor(() => {
      expect(document.querySelector('#gameday-top-nav')).toBeInTheDocument();
    });
  });

  it('スコアとランクが表示されるべき', async () => {
    render(<GamedayLayout>content</GamedayLayout>);
    await waitFor(() => {
      expect(screen.getAllByText(/Score: /).length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText(/Rank: /).length).toBeGreaterThanOrEqual(1);
    });
  });

  it('チーム名が表示されるべき', async () => {
    render(<GamedayLayout>content</GamedayLayout>);
    await waitFor(() => {
      expect(screen.getAllByText('TeamAlpha').length).toBeGreaterThanOrEqual(1);
    });
  });

  it('現在の言語が表示されるべき', async () => {
    render(<GamedayLayout>content</GamedayLayout>);
    await waitFor(() => {
      // locale.toUpperCase() is shown as the dropdown trigger (JA or EN)
      const localeItems = screen.getAllByText(/^(JA|EN)$/);
      expect(localeItems.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('子コンテンツが表示されるべき', async () => {
    render(<GamedayLayout>test content</GamedayLayout>);
    await waitFor(() => {
      expect(screen.getByText('test content')).toBeInTheDocument();
    });
  });
});
