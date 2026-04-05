import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import AdminProblemDetailPage from '../page';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  useParams: () => ({ id: 'prob-1' }),
}));

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: null, status: 'unauthenticated' }),
}));

vi.mock('@/lib/tenant', () => ({
  getTenantId: vi.fn().mockReturnValue('test-tenant'),
  useTenantOptional: () => null,
}));

const mockGetProblem = vi.fn();
const mockDeleteProblem = vi.fn();

vi.mock('@/lib/api/admin-problems', () => ({
  getProblem: (...args: unknown[]) => mockGetProblem(...args),
  deleteProblem: (...args: unknown[]) => mockDeleteProblem(...args),
}));

const baseProblem = {
  id: 'prob-1',
  title: 'SQLインジェクション基礎',
  type: 'gameday' as const,
  category: 'web' as const,
  difficulty: 'medium' as const,
  description: {
    overview: 'SQLインジェクションの基礎を学ぶ問題です',
    objectives: ['SQLインジェクションを理解する'],
    hints: ['ヒント1'],
    prerequisites: [],
  },
  metadata: {
    author: 'admin',
    version: '1.0',
    tags: ['sql', 'web'],
  },
  deployment: {
    providers: ['aws' as const],
    templates: {},
    regions: {},
  },
  scoring: {
    type: 'lambda' as const,
    path: 'handler.lambda',
    timeoutMinutes: 5,
    criteria: [
      { name: '正解', description: '正解', weight: 1, maxPoints: 100 },
    ],
  },
};

describe('AdminProblemDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetProblem.mockResolvedValue(baseProblem);
  });

  it('ローディング中は問題データを表示しないべき', () => {
    mockGetProblem.mockReturnValue(new Promise(() => {}));
    render(<AdminProblemDetailPage />);
    expect(
      screen.queryByText('SQLインジェクション基礎'),
    ).not.toBeInTheDocument();
  });

  it('問題タイトルを表示すべき', async () => {
    render(<AdminProblemDetailPage />);

    await waitFor(() => {
      expect(screen.getByText('SQLインジェクション基礎')).toBeInTheDocument();
    });
  });

  it('問題概要を表示すべき', async () => {
    render(<AdminProblemDetailPage />);

    await waitFor(() => {
      expect(
        screen.getByText('SQLインジェクションの基礎を学ぶ問題です'),
      ).toBeInTheDocument();
    });
  });

  it('APIエラー時にエラーメッセージを表示すべき', async () => {
    mockGetProblem.mockRejectedValue(new Error('API Error'));
    render(<AdminProblemDetailPage />);

    await waitFor(() => {
      expect(screen.getByText('問題の取得に失敗しました')).toBeInTheDocument();
    });
  });

  it('問題一覧へ戻るリンクを表示すべき', async () => {
    render(<AdminProblemDetailPage />);

    await waitFor(() => {
      const links = screen.getAllByRole('link');
      const backLink = links.find(
        (l) =>
          l.getAttribute('href') === '/admin/problems' ||
          l.textContent?.includes('問題一覧'),
      );
      expect(backLink).toBeTruthy();
    });
  });
});
