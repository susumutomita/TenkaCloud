import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminProblem } from '@/lib/api/admin-types';
import AdminMarketplacePage from '../page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useParams: () => ({}),
}));
vi.mock('next-auth/react', () => ({
  SessionProvider: ({ children }: { children: React.ReactNode }) => children,
  useSession: () => ({ data: null, status: 'unauthenticated' }),
  getSession: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/tenant', () => ({ useTenantOptional: () => null }));

const mocks = vi.hoisted(() => ({
  getProblems: vi.fn(),
  getProblem: vi.fn(),
}));
vi.mock('@/lib/api/admin-problems', () => mocks);
const mockGetProblems = mocks.getProblems;
const mockGetProblem = mocks.getProblem;

const baseProblem: AdminProblem = {
  id: 'prob-1',
  title: 'S3 セキュリティ設定',
  type: 'gameday',
  category: 'security',
  difficulty: 'medium',
  description: {
    overview: 'S3 バケットのセキュリティを強化する問題です',
    objectives: ['パブリックアクセスを無効化', '暗号化を有効化'],
    hints: ['バケットポリシーを確認'],
    prerequisites: ['AWS の基本知識'],
    estimatedTime: 45,
  },
  metadata: {
    author: 'テスト太郎',
    version: '1.0.0',
    tags: ['s3', 'security', 'encryption'],
    createdAt: '2026-01-01T00:00:00Z',
  },
  deployment: {
    providers: ['aws'],
    timeout: 300,
    templates: { main: { type: 'cloudformation', path: '/templates/s3.yaml' } },
    regions: { aws: ['ap-northeast-1'] },
  },
  scoring: {
    type: 'lambda',
    path: '/scoring/s3-check.ts',
    timeoutMinutes: 5,
    criteria: [
      {
        name: 'パブリックアクセス無効化',
        weight: 50,
        maxPoints: 50,
      },
      {
        name: '暗号化有効化',
        description: 'SSE-S3 or SSE-KMS',
        weight: 50,
        maxPoints: 50,
      },
    ],
  },
  createdAt: '2026-01-01T00:00:00Z',
};
const problemsResponse = { problems: [baseProblem], total: 1 };

describe('Admin マーケットプレイスページ', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function renderAndWait() {
    await act(async () => {
      render(<AdminMarketplacePage />);
    });
    await waitFor(() => {
      expect(screen.getByText(/S3 セキュリティ設定/)).toBeInTheDocument();
    });
  }

  describe('プレビューモーダル', () => {
    it('プレビューボタンをクリックすると問題詳細モーダルを表示すべき', async () => {
      const user = userEvent.setup();
      mockGetProblems.mockResolvedValue(problemsResponse);
      mockGetProblem.mockResolvedValue(baseProblem);
      await renderAndWait();
      await user.click(screen.getByRole('button', { name: 'プレビュー' }));
      await waitFor(() => {
        expect(screen.getByText('1.0.0')).toBeInTheDocument();
      });
    });

    it('プレビューモーダルに採点基準を表示すべき', async () => {
      const user = userEvent.setup();
      mockGetProblems.mockResolvedValue(problemsResponse);
      mockGetProblem.mockResolvedValue(baseProblem);
      await renderAndWait();
      await user.click(screen.getByRole('button', { name: 'プレビュー' }));
      await waitFor(() => {
        expect(
          screen.getByText('パブリックアクセス無効化'),
        ).toBeInTheDocument();
      });
      expect(screen.getByText('暗号化有効化')).toBeInTheDocument();
    });

    it('プレビューモーダルにデプロイ情報を表示すべき', async () => {
      const user = userEvent.setup();
      mockGetProblems.mockResolvedValue(problemsResponse);
      mockGetProblem.mockResolvedValue(baseProblem);
      await renderAndWait();
      await user.click(screen.getByRole('button', { name: 'プレビュー' }));
      await waitFor(() => {
        expect(screen.getByText('cloudformation')).toBeInTheDocument();
      });
    });

    it('getProblem でエラーが発生してもモーダルは表示すべき', async () => {
      const user = userEvent.setup();
      mockGetProblems.mockResolvedValue(problemsResponse);
      mockGetProblem.mockRejectedValue(new Error('Not found'));
      await renderAndWait();
      await user.click(screen.getByRole('button', { name: 'プレビュー' }));
      await waitFor(() => {
        expect(
          screen.getByText('問題詳細の取得に失敗しました'),
        ).toBeInTheDocument();
      });
    });

    it('プレビューモーダルに目標を表示すべき', async () => {
      const user = userEvent.setup();
      mockGetProblems.mockResolvedValue(problemsResponse);
      mockGetProblem.mockResolvedValue(baseProblem);
      await renderAndWait();
      await user.click(screen.getByRole('button', { name: 'プレビュー' }));
      await waitFor(() => {
        expect(
          screen.getByText('パブリックアクセスを無効化'),
        ).toBeInTheDocument();
      });
    });
  });

  describe('イベントに追加モーダル', () => {
    it('イベント取得エラー時はエラーメッセージを表示すべき', async () => {
      const user = userEvent.setup();
      mockGetProblems.mockResolvedValue(problemsResponse);
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: 'Failed' }),
      });
      vi.stubGlobal('fetch', mockFetch);
      await renderAndWait();
      await user.click(
        screen.getByRole('button', {
          name: 'イベントに追加',
        }),
      );
      await waitFor(() => {
        expect(
          screen.getByText('イベント一覧の取得に失敗しました'),
        ).toBeInTheDocument();
      });
    });
  });

  describe('ボタンの状態', () => {
    it('プレビューボタンが有効であるべき', async () => {
      mockGetProblems.mockResolvedValue(problemsResponse);
      await renderAndWait();
      expect(
        screen.getByRole('button', { name: 'プレビュー' }),
      ).not.toBeDisabled();
    });

    it('イベントに追加ボタンが有効であるべき', async () => {
      mockGetProblems.mockResolvedValue(problemsResponse);
      await renderAndWait();
      expect(
        screen.getByRole('button', {
          name: 'イベントに追加',
        }),
      ).not.toBeDisabled();
    });
  });
});
