import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import AlliancePage from '../page';

vi.mock('next/navigation', () => ({
  useParams: () => ({ eventId: 'ev-1' }),
}));

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: null, status: 'unauthenticated' }),
}));

vi.mock('@/lib/hooks/use-gameday-session', () => ({
  useGamedaySession: () => ({
    eventId: 'ev-1',
    teamId: 'team-1',
    teamName: 'TeamAlpha',
  }),
}));

const mockGetAlliances = vi.fn();
const mockAcceptAlliance = vi.fn();
const mockBreakAlliance = vi.fn();
const mockRequestAlliance = vi.fn();

vi.mock('@/lib/api/gameday', () => ({
  getAlliances: (...args: unknown[]) => mockGetAlliances(...args),
  acceptAlliance: (...args: unknown[]) => mockAcceptAlliance(...args),
  breakAlliance: (...args: unknown[]) => mockBreakAlliance(...args),
  requestAlliance: (...args: unknown[]) => mockRequestAlliance(...args),
}));

const mockAddNotification = vi.fn();
vi.mock('@/lib/notifications', () => ({
  useNotifications: () => ({ addNotification: mockAddNotification }),
}));

const baseAlliance = {
  id: 'ally-1',
  requesterTeamId: 'team-1',
  targetTeamId: 'team-2',
  status: 'ACTIVE' as const,
  createdAt: '2024-06-01T10:00:00Z',
  updatedAt: '2024-06-01T10:30:00Z',
};

describe('AlliancePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            teams: [
              { teamId: 'team-1', teamName: 'TeamAlpha' },
              { teamId: 'team-2', teamName: 'TeamBeta' },
            ],
          }),
      }),
    );
    mockGetAlliances.mockResolvedValue({ alliances: [] });
  });

  it('ローディング中は同盟データを表示しないべき', () => {
    mockGetAlliances.mockReturnValue(new Promise(() => {}));
    render(<AlliancePage />);
    expect(screen.queryByText('team-2')).not.toBeInTheDocument();
  });

  it('同盟ページのヘッダーを表示すべき', async () => {
    render(<AlliancePage />);

    await waitFor(() => {
      expect(screen.getByText('Alliance')).toBeInTheDocument();
    });
  });

  it('同盟リクエスト送信フォームを表示すべき', async () => {
    render(<AlliancePage />);

    await waitFor(() => {
      expect(screen.getByText('Send alliance request')).toBeInTheDocument();
    });
  });

  it('アクティブ同盟を表示すべき', async () => {
    mockGetAlliances.mockResolvedValue({ alliances: [baseAlliance] });
    render(<AlliancePage />);

    await waitFor(() => {
      expect(screen.getByText('team-2')).toBeInTheDocument();
    });
    // Active badge
    const activeElements = screen.getAllByText('Active');
    expect(activeElements.length).toBeGreaterThanOrEqual(1);
  });

  it('同盟がない場合は空状態メッセージを表示すべき', async () => {
    render(<AlliancePage />);

    await waitFor(() => {
      expect(screen.getByText('No alliances.')).toBeInTheDocument();
    });
  });

  it('受信した同盟リクエストを表示すべき', async () => {
    const pendingAlliance = {
      ...baseAlliance,
      id: 'ally-2',
      requesterTeamId: 'team-2',
      targetTeamId: 'team-1',
      status: 'PENDING' as const,
    };
    mockGetAlliances.mockResolvedValue({ alliances: [pendingAlliance] });
    render(<AlliancePage />);

    await waitFor(() => {
      expect(screen.getByText('Incoming requests')).toBeInTheDocument();
    });
  });

  it('APIエラー時にエラーメッセージを表示すべき', async () => {
    mockGetAlliances.mockRejectedValue(new Error('読み込みに失敗しました'));
    render(<AlliancePage />);

    await waitFor(() => {
      expect(screen.getByText('読み込みに失敗しました')).toBeInTheDocument();
    });
  });
});
