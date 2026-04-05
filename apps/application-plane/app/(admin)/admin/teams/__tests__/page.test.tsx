import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import AdminTeamsPage from '../page';

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: null, status: 'unauthenticated' }),
}));

vi.mock('@/lib/tenant', () => ({
  getTenantId: vi.fn().mockReturnValue('test-tenant'),
  useTenantOptional: () => null,
}));

const baseTeam = {
  id: 'team-1',
  name: 'TeamAlpha',
  members: [],
  captainId: 'user-1',
  inviteCode: 'ALPHA123',
  memberCount: 3,
  maxMembers: 5,
  eventsCount: 2,
  totalScore: 2500,
  createdAt: '2024-06-01T10:00:00Z',
};

describe('AdminTeamsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ teams: [baseTeam], total: 1 }),
      }),
    );
  });

  it('ローディング中はチームデータを表示しないべき', () => {
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));
    render(<AdminTeamsPage />);
    expect(screen.queryByText('TeamAlpha')).not.toBeInTheDocument();
  });

  it('チーム管理ページのタイトルを表示すべき', async () => {
    render(<AdminTeamsPage />);

    await waitFor(() => {
      expect(screen.getByText('チーム管理')).toBeInTheDocument();
    });
  });

  it('チームカードを表示すべき', async () => {
    render(<AdminTeamsPage />);

    await waitFor(() => {
      expect(screen.getByText('TeamAlpha')).toBeInTheDocument();
    });
  });

  it('チーム統計を表示すべき', async () => {
    render(<AdminTeamsPage />);

    await waitFor(() => {
      expect(screen.getByText('総チーム数')).toBeInTheDocument();
    });
    expect(screen.getByText('総メンバー数')).toBeInTheDocument();
  });

  it('APIエラー時にエラーメッセージを表示すべき', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: 'チームの取得に失敗しました' }),
      }),
    );
    render(<AdminTeamsPage />);

    await waitFor(() => {
      expect(screen.getByText('エラーが発生しました')).toBeInTheDocument();
    });
  });

  it('チームが空の場合は空状態メッセージを表示すべき', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ teams: [], total: 0 }),
      }),
    );
    render(<AdminTeamsPage />);

    await waitFor(() => {
      expect(screen.getByText('チームが見つかりません')).toBeInTheDocument();
    });
  });
});
