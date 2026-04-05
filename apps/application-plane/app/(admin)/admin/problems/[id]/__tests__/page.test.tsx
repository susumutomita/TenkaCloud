import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import AdminProblemDetailPage from '../page';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  useParams: () => ({ id: 'prob-1' }),
}));

vi.mock('next-auth/react', () => ({
  SessionProvider: ({ children }: { children: React.ReactNode }) => children,
  useSession: () => ({ data: null, status: 'unauthenticated' }),
  getSession: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/tenant', () => ({
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
  title: 'EC2 セキュリティグループ設定',
  type: 'gameday' as const,
  category: 'security' as const,
  difficulty: 'hard' as const,
  description: {
    overview: 'EC2インスタンスのSGを適切に設定する問題',
    objectives: ['ポート22を閉じる', 'ポート443を開ける'],
    hints: ['ヒント1'],
    prerequisites: [],
  },
  metadata: {
    author: 'admin',
    version: '2.0',
    tags: ['aws', 'security'],
    license: 'MIT',
  },
  deployment: {
    providers: ['aws'],
    timeout: 1200,
    templates: {},
    regions: { aws: ['ap-northeast-1'] },
  },
  scoring: {
    type: 'lambda' as const,
    path: 'scoring/',
    timeoutMinutes: 30,
    criteria: [
      {
        name: '基準1',
        description: '説明',
        weight: 1.0,
        maxPoints: 100,
      },
    ],
  },
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-06-01T00:00:00Z',
};

describe('AdminProblemDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ローディング中はデータを表示しないべき', () => {
    mockGetProblem.mockReturnValue(new Promise(() => {}));
    render(<AdminProblemDetailPage />);
    expect(
      screen.queryByText('EC2 セキュリティグループ設定'),
    ).not.toBeInTheDocument();
  });

  it('問題詳細を取得して表示すべき', async () => {
    mockGetProblem.mockResolvedValue(baseProblem);
    render(<AdminProblemDetailPage />);

    await waitFor(() => {
      expect(
        screen.getAllByText('EC2 セキュリティグループ設定').length,
      ).toBeGreaterThanOrEqual(1);
    });
    expect(
      screen.getByText('EC2インスタンスのSGを適切に設定する問題'),
    ).toBeInTheDocument();
  });

  it('目標一覧を表示すべき', async () => {
    mockGetProblem.mockResolvedValue(baseProblem);
    render(<AdminProblemDetailPage />);

    await waitFor(() => {
      expect(screen.getByText('ポート22を閉じる')).toBeInTheDocument();
    });
    expect(screen.getByText('ポート443を開ける')).toBeInTheDocument();
  });

  it('APIエラー時にエラーメッセージを表示すべき', async () => {
    mockGetProblem.mockRejectedValue(new Error('ネットワークエラー'));
    render(<AdminProblemDetailPage />);

    await waitFor(() => {
      // Page shows hardcoded error message
      expect(screen.getByText('問題の取得に失敗しました')).toBeInTheDocument();
    });
  });

  it('問題が見つからない場合はコンテンツを表示しないべき', async () => {
    mockGetProblem.mockResolvedValue(null);
    render(<AdminProblemDetailPage />);

    // When no problem found, page does not show problem content
    await waitFor(() => {
      // Data specific to the problem shouldn't be there
      expect(
        screen.queryByText('EC2 セキュリティグループ設定'),
      ).not.toBeInTheDocument();
    });
  });

  it('削除ボタンを表示すべき', async () => {
    mockGetProblem.mockResolvedValue(baseProblem);
    render(<AdminProblemDetailPage />);

    await waitFor(() => {
      const buttons = screen.getAllByRole('button');
      const deleteButton = buttons.find((b) => b.textContent?.includes('削除'));
      expect(deleteButton).toBeTruthy();
    });
  });
});
