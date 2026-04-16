import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import BadgesPage from '../page';

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

const mockGetMyBadges = vi.fn();
vi.mock('@/lib/api/profile', () => ({
  getMyBadges: (...args: unknown[]) => mockGetMyBadges(...args),
}));

const baseBadge = {
  id: 'badge-1',
  name: 'ファーストウィン',
  description: '初めてイベントで1位を獲得した',
  iconUrl: 'https://example.com/badge.png',
  earnedAt: '2024-06-01T10:00:00Z',
};

describe('BadgesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ローディング中はバッジデータを表示しないべき', () => {
    mockGetMyBadges.mockReturnValue(new Promise(() => {}));
    render(<BadgesPage />);
    expect(screen.queryByText('ファーストウィン')).not.toBeInTheDocument();
  });

  it('APIからバッジ一覧を取得して表示すべき', async () => {
    mockGetMyBadges.mockResolvedValue({ badges: [baseBadge] });
    render(<BadgesPage />);

    await waitFor(() => {
      expect(screen.getByText('ファーストウィン')).toBeInTheDocument();
    });
    expect(
      screen.getByText('初めてイベントで1位を獲得した'),
    ).toBeInTheDocument();
  });

  it('バッジがない場合は空状態メッセージを表示すべき', async () => {
    mockGetMyBadges.mockResolvedValue({ badges: [] });
    render(<BadgesPage />);

    await waitFor(() => {
      // English locale
      expect(screen.getByText('No badges earned yet')).toBeInTheDocument();
    });
  });

  it('プロフィールへ戻るリンクを表示すべき', async () => {
    mockGetMyBadges.mockResolvedValue({ badges: [] });
    render(<BadgesPage />);

    await waitFor(() => {
      // English locale: "← Profile"
      const links = screen.getAllByRole('link');
      const backLink = links.find((l) => l.textContent?.includes('Profile'));
      expect(backLink).toBeTruthy();
    });
  });

  it('バッジのヘッダーに件数を表示すべき', async () => {
    mockGetMyBadges.mockResolvedValue({
      badges: [
        baseBadge,
        { ...baseBadge, id: 'badge-2', name: 'セカンドウィン' },
      ],
    });
    render(<BadgesPage />);

    await waitFor(() => {
      expect(screen.getByText('ファーストウィン')).toBeInTheDocument();
    });
    // The header shows count: "バッジ (2)"
    expect(screen.getByText(/\(2\)/)).toBeInTheDocument();
  });

  it('APIエラー時でも空状態を表示すべき', async () => {
    mockGetMyBadges.mockRejectedValue(new Error('Network error'));
    render(<BadgesPage />);

    await waitFor(() => {
      // English locale
      expect(screen.getByText('No badges earned yet')).toBeInTheDocument();
    });
  });

  it('バッジの取得日を表示すべき', async () => {
    mockGetMyBadges.mockResolvedValue({ badges: [baseBadge] });
    render(<BadgesPage />);

    await waitFor(() => {
      // English locale: "Acquired"
      expect(screen.getByText('Acquired')).toBeInTheDocument();
    });
  });
});
