import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import AdminTeamsPage from '../page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useParams: () => ({}),
  useSearchParams: () => ({ get: (_: string) => null }),
}));

vi.mock('next-auth/react', () => ({
  SessionProvider: ({ children }: { children: React.ReactNode }) => children,
  useSession: () => ({ data: null, status: 'unauthenticated' }),
  getSession: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/tenant', () => ({
  useTenantOptional: () => null,
}));

const baseTeams = [
  {
    id: 'team-1',
    name: 'チームA',
    members: [],
    captainId: 'user-1',
    inviteCode: 'CODE123',
    memberCount: 3,
    maxMembers: 5,
    eventsCount: 2,
    totalScore: 2500,
    createdAt: '2024-01-01T00:00:00Z',
  },
  {
    id: 'team-2',
    name: 'チームB',
    members: [],
    captainId: 'user-2',
    inviteCode: 'CODE456',
    memberCount: 2,
    maxMembers: 5,
    eventsCount: 1,
    totalScore: 1200,
    createdAt: '2024-02-01T00:00:00Z',
  },
];

describe('AdminTeamsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ローディング中はデータを表示しないべき', () => {
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));
    render(<AdminTeamsPage />);
    expect(screen.queryByText('チームA')).not.toBeInTheDocument();
  });

  it('チーム一覧を取得して表示すべき', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ teams: baseTeams, total: 2 }),
      }),
    );
    render(<AdminTeamsPage />);

    await waitFor(() => {
      expect(screen.getAllByText('チームA').length).toBeGreaterThanOrEqual(1);
    });
    expect(screen.getAllByText('チームB').length).toBeGreaterThanOrEqual(1);
  });

  it('チーム管理ヘッダーを表示すべき', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ teams: [], total: 0 }),
      }),
    );
    render(<AdminTeamsPage />);

    await waitFor(() => {
      expect(screen.getAllByText(/チーム管理/).length).toBeGreaterThanOrEqual(
        1,
      );
    });
  });

  it('APIエラー時にエラーメッセージを表示すべき', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({ error: '取得に失敗しました' }),
      }),
    );
    render(<AdminTeamsPage />);

    await waitFor(() => {
      expect(screen.getByText('エラーが発生しました')).toBeInTheDocument();
    });
  });

  it('チームが0件の場合は空状態メッセージを表示すべき', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ teams: [], total: 0 }),
      }),
    );
    render(<AdminTeamsPage />);

    await waitFor(() => {
      expect(screen.getByText('チームが見つかりません')).toBeInTheDocument();
    });
  });
});
