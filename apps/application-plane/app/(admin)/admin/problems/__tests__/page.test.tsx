import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import AdminProblemsPage from '../page';

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

const mockGetProblems = vi.fn();
const mockDeleteProblem = vi.fn();
vi.mock('@/lib/api/admin-problems', () => ({
  getProblems: (...args: unknown[]) => mockGetProblems(...args),
  deleteProblem: (...args: unknown[]) => mockDeleteProblem(...args),
}));

const baseProblem = {
  id: 'prob-1',
  title: 'S3 バケット設定問題',
  type: 'jam' as const,
  category: 'security' as const,
  difficulty: 'medium' as const,
  description: {
    overview: '概要',
    detail: '詳細説明',
    objectives: ['目標1'],
    instructions: [],
  },
  metadata: {
    author: 'admin',
    version: '1.0',
    tags: [],
    prerequisites: [],
    estimatedTimeMinutes: 30,
    maxScore: 100,
    pointMultiplier: 1,
  },
  deployment: {
    providers: ['aws'],
    timeout: 600,
  },
  scoring: {
    type: 'automatic',
    criteria: [],
  },
  createdAt: '2024-01-01T00:00:00Z',
};

describe('AdminProblemsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ローディング中はデータを表示しないべき', () => {
    mockGetProblems.mockReturnValue(new Promise(() => {}));
    render(<AdminProblemsPage />);
    expect(screen.queryByText('S3 バケット設定問題')).not.toBeInTheDocument();
  });

  it('問題一覧を取得して表示すべき', async () => {
    mockGetProblems.mockResolvedValue({ problems: [baseProblem], total: 1 });
    render(<AdminProblemsPage />);

    await waitFor(() => {
      expect(
        screen.getAllByText('S3 バケット設定問題').length,
      ).toBeGreaterThanOrEqual(1);
    });
  });

  it('問題管理ヘッダーを表示すべき', async () => {
    mockGetProblems.mockResolvedValue({ problems: [], total: 0 });
    render(<AdminProblemsPage />);

    await waitFor(() => {
      expect(screen.getAllByText(/問題管理/).length).toBeGreaterThanOrEqual(1);
    });
  });

  it('APIエラー時にエラーメッセージを表示すべき', async () => {
    mockGetProblems.mockRejectedValue(new Error('ネットワークエラー'));
    render(<AdminProblemsPage />);

    await waitFor(() => {
      // Error message is hardcoded in the page
      expect(screen.getByText('問題の取得に失敗しました')).toBeInTheDocument();
    });
  });

  it('問題が0件の場合は空状態メッセージを表示すべき', async () => {
    mockGetProblems.mockResolvedValue({ problems: [], total: 0 });
    render(<AdminProblemsPage />);

    await waitFor(() => {
      expect(screen.getByText('問題が見つかりません')).toBeInTheDocument();
    });
  });

  it('新規問題作成リンクを表示すべき', async () => {
    mockGetProblems.mockResolvedValue({ problems: [], total: 0 });
    render(<AdminProblemsPage />);

    await waitFor(() => {
      // Rendered as Link with asChild, so it's an anchor element
      const links = screen.getAllByRole('link');
      const createLink = links.find((l) =>
        l.textContent?.includes('新規問題作成'),
      );
      expect(createLink).toBeTruthy();
    });
  });
});
