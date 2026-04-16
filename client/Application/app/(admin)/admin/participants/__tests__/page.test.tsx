import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import AdminParticipantsPage from '../page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => ({ get: (_: string) => null }),
}));

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: null, status: 'unauthenticated' }),
}));

vi.mock('@/lib/tenant', () => ({
  getTenantId: vi.fn().mockReturnValue('test-tenant'),
  useTenantOptional: () => null,
}));

const baseParticipant = {
  id: 'user-1',
  userId: 'uid-1',
  displayName: 'Alice',
  email: 'alice@example.com',
  role: 'participant' as const,
  joinedAt: '2024-06-01T10:00:00Z',
  status: 'active' as const,
  eventsCount: 3,
  totalScore: 1500,
};

describe('AdminParticipantsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ participants: [baseParticipant], total: 1 }),
      }),
    );
  });

  it('ローディング中は参加者データを表示しないべき', () => {
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));
    render(<AdminParticipantsPage />);
    expect(screen.queryByText('Alice')).not.toBeInTheDocument();
  });

  it('参加者管理ページのタイトルを表示すべき', async () => {
    render(<AdminParticipantsPage />);

    await waitFor(() => {
      expect(screen.getByText('参加者管理')).toBeInTheDocument();
    });
  });

  it('参加者リストを表示すべき', async () => {
    render(<AdminParticipantsPage />);

    await waitFor(() => {
      expect(screen.getByText('Alice')).toBeInTheDocument();
    });
    expect(screen.getByText('alice@example.com')).toBeInTheDocument();
  });

  it('参加者統計を表示すべき', async () => {
    render(<AdminParticipantsPage />);

    await waitFor(() => {
      expect(screen.getByText('総参加者数')).toBeInTheDocument();
    });
    expect(screen.getByText('アクティブユーザー')).toBeInTheDocument();
  });

  it('APIエラー時にエラーメッセージを表示すべき', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: '参加者の取得に失敗しました' }),
      }),
    );
    render(<AdminParticipantsPage />);

    await waitFor(() => {
      expect(screen.getByText('エラーが発生しました')).toBeInTheDocument();
    });
  });

  it('参加者が空の場合は空状態メッセージを表示すべき', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ participants: [], total: 0 }),
      }),
    );
    render(<AdminParticipantsPage />);

    await waitFor(() => {
      expect(screen.getByText('参加者が見つかりません')).toBeInTheDocument();
    });
  });
});
