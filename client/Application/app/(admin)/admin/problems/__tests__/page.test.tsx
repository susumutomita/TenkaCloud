import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import AdminProblemsPage from '../page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: null, status: 'unauthenticated' }),
}));

vi.mock('@/lib/tenant', () => ({
  getTenantId: vi.fn().mockReturnValue('test-tenant'),
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

describe('AdminProblemsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetProblems.mockResolvedValue({ problems: [baseProblem], total: 1 });
  });

  it('ローディング中は問題データを表示しないべき', () => {
    mockGetProblems.mockReturnValue(new Promise(() => {}));
    render(<AdminProblemsPage />);
    expect(
      screen.queryByText('SQLインジェクション基礎'),
    ).not.toBeInTheDocument();
  });

  it('問題一覧を表示すべき', async () => {
    render(<AdminProblemsPage />);

    await waitFor(() => {
      expect(screen.getByText('SQLインジェクション基礎')).toBeInTheDocument();
    });
  });

  it('新規問題作成リンクを表示すべき', async () => {
    render(<AdminProblemsPage />);

    await waitFor(() => {
      const links = screen.getAllByRole('link');
      const newLink = links.find((l) => l.textContent?.includes('新規問題'));
      expect(newLink).toBeTruthy();
    });
  });

  it('APIエラー時にエラーメッセージを表示すべき', async () => {
    mockGetProblems.mockRejectedValue(new Error('API Error'));
    render(<AdminProblemsPage />);

    await waitFor(() => {
      expect(screen.getByText('問題の取得に失敗しました')).toBeInTheDocument();
    });
  });

  it('問題が空の場合は空状態を表示すべき', async () => {
    mockGetProblems.mockResolvedValue({ problems: [], total: 0 });
    render(<AdminProblemsPage />);

    await waitFor(() => {
      // No problem cards shown
      expect(
        screen.queryByText('SQLインジェクション基礎'),
      ).not.toBeInTheDocument();
    });
  });
});
