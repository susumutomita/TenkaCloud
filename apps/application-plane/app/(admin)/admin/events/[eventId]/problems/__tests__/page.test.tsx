import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import AdminEventProblemsPage from '../page';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  useParams: () => ({ eventId: 'ev-1' }),
}));

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: null, status: 'unauthenticated' }),
}));

vi.mock('@/lib/tenant', () => ({
  getTenantId: vi.fn().mockReturnValue('test-tenant'),
  useTenantOptional: () => null,
}));

const mockGetEventProblems = vi.fn();
const mockGetProblems = vi.fn();
const mockAddProblemToEvent = vi.fn();
const mockRemoveProblemFromEvent = vi.fn();

vi.mock('@/lib/api/admin-problems', () => ({
  getEventProblems: (...args: unknown[]) => mockGetEventProblems(...args),
  getProblems: (...args: unknown[]) => mockGetProblems(...args),
  addProblemToEvent: (...args: unknown[]) => mockAddProblemToEvent(...args),
  removeProblemFromEvent: (...args: unknown[]) =>
    mockRemoveProblemFromEvent(...args),
}));

const baseProblem = {
  id: 'prob-1',
  title: 'SQLインジェクション基礎',
  type: 'gameday' as const,
  category: 'web' as const,
  difficulty: 'medium' as const,
  description: {
    overview: 'SQLインジェクションの基礎',
    objectives: [],
    hints: [],
    prerequisites: [],
  },
  metadata: { author: 'admin', version: '1.0', tags: [] },
  deployment: { providers: ['aws' as const], templates: {}, regions: {} },
  scoring: {
    type: 'lambda' as const,
    path: 'handler',
    timeoutMinutes: 5,
    criteria: [{ name: '正解', weight: 1, maxPoints: 100 }],
  },
};

describe('AdminEventProblemsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetEventProblems.mockResolvedValue({ problems: [] });
    mockGetProblems.mockResolvedValue({ problems: [], total: 0 });
  });

  it('ローディング中は問題データを表示しないべき', () => {
    mockGetEventProblems.mockReturnValue(new Promise(() => {}));
    render(<AdminEventProblemsPage />);
    expect(
      screen.queryByText('SQLインジェクション基礎'),
    ).not.toBeInTheDocument();
  });

  it('問題管理ページのタイトルを表示すべき', async () => {
    render(<AdminEventProblemsPage />);

    await waitFor(() => {
      expect(screen.getByText('問題管理')).toBeInTheDocument();
    });
  });

  it('問題リストを表示すべき', async () => {
    mockGetEventProblems.mockResolvedValue({ problems: [baseProblem] });
    render(<AdminEventProblemsPage />);

    await waitFor(() => {
      expect(screen.getByText('SQLインジェクション基礎')).toBeInTheDocument();
    });
  });

  it('問題が空の場合は空状態メッセージを表示すべき', async () => {
    render(<AdminEventProblemsPage />);

    await waitFor(() => {
      expect(screen.getByText('問題がまだありません')).toBeInTheDocument();
    });
  });

  it('問題追加ボタンを表示すべき', async () => {
    render(<AdminEventProblemsPage />);

    await waitFor(() => {
      const addButtons = screen.getAllByRole('button', {
        name: /問題を追加/i,
      });
      expect(addButtons.length).toBeGreaterThanOrEqual(1);
    });
  });
});
