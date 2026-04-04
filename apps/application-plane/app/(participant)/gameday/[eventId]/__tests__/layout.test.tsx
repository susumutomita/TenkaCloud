import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

  it('ヘッダーが通常ページと同じスタイルを持つべき', async () => {
    render(<GamedayLayout>content</GamedayLayout>);
    await waitFor(() => {
      const header = document.querySelector('#gameday-top-nav header');
      expect(header).toBeInTheDocument();
    });
  });

  it('スコアとランクが表示されるべき', async () => {
    render(<GamedayLayout>content</GamedayLayout>);
    await waitFor(() => {
      expect(screen.getByText(/Score:/)).toBeInTheDocument();
    });
  });

  it('チーム名が表示されるべき', async () => {
    render(<GamedayLayout>content</GamedayLayout>);
    await waitFor(() => {
      expect(screen.getByText('TeamAlpha')).toBeInTheDocument();
    });
  });

  it('JA/EN 言語切り替えが表示されるべき', async () => {
    render(<GamedayLayout>content</GamedayLayout>);
    await waitFor(() => {
      expect(screen.getByText('JA')).toBeInTheDocument();
      expect(screen.getByText('EN')).toBeInTheDocument();
    });
  });

  it('子コンテンツが表示されるべき', async () => {
    render(<GamedayLayout>test content</GamedayLayout>);
    await waitFor(() => {
      expect(screen.getByText('test content')).toBeInTheDocument();
    });
  });
});
