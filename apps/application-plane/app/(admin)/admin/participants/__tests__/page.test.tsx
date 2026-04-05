import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import AdminParticipantsPage from '../page';

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

const baseParticipants = [
  {
    id: 'user-1',
    userId: 'uid-1',
    displayName: 'Alice',
    email: 'alice@example.com',
    role: 'participant',
    status: 'active',
    totalScore: 1500,
    eventsParticipated: 3,
    joinedAt: '2024-01-01T00:00:00Z',
  },
  {
    id: 'user-2',
    userId: 'uid-2',
    displayName: 'Bob',
    email: 'bob@example.com',
    role: 'participant',
    status: 'inactive',
    totalScore: 800,
    eventsParticipated: 1,
    joinedAt: '2024-02-01T00:00:00Z',
  },
];

describe('AdminParticipantsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ローディング中はデータを表示しないべき', () => {
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));
    render(<AdminParticipantsPage />);
    expect(screen.queryByText('Alice')).not.toBeInTheDocument();
  });

  it('参加者一覧を取得して表示すべき', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ participants: baseParticipants, total: 2 }),
      }),
    );
    render(<AdminParticipantsPage />);

    await waitFor(() => {
      expect(screen.getAllByText('Alice').length).toBeGreaterThanOrEqual(1);
    });
    expect(screen.getAllByText('Bob').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('alice@example.com')).toBeInTheDocument();
  });

  it('参加者管理ヘッダーを表示すべき', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ participants: [], total: 0 }),
      }),
    );
    render(<AdminParticipantsPage />);

    await waitFor(() => {
      expect(screen.getAllByText(/参加者管理/).length).toBeGreaterThanOrEqual(
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
    render(<AdminParticipantsPage />);

    await waitFor(() => {
      expect(screen.getByText('エラーが発生しました')).toBeInTheDocument();
    });
  });

  it('参加者が0件の場合は空状態メッセージを表示すべき', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ participants: [], total: 0 }),
      }),
    );
    render(<AdminParticipantsPage />);

    await waitFor(() => {
      expect(screen.getByText('参加者が見つかりません')).toBeInTheDocument();
    });
  });
});
