import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
const mockDeployProblem = vi.fn();
const mockGetDeploymentStatus = vi.fn();
const mockDeleteDeployment = vi.fn();

vi.mock('@/lib/api/admin-problems', () => ({
  getEventProblems: (...args: unknown[]) => mockGetEventProblems(...args),
  getProblems: (...args: unknown[]) => mockGetProblems(...args),
  addProblemToEvent: (...args: unknown[]) => mockAddProblemToEvent(...args),
  removeProblemFromEvent: (...args: unknown[]) =>
    mockRemoveProblemFromEvent(...args),
  deployProblem: (...args: unknown[]) => mockDeployProblem(...args),
  getDeploymentStatus: (...args: unknown[]) => mockGetDeploymentStatus(...args),
  deleteDeployment: (...args: unknown[]) => mockDeleteDeployment(...args),
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
  deployment: {
    providers: ['aws' as const],
    templates: {
      aws: {
        type: 'cloudformation' as const,
        path: 's3://templates/problem.yaml',
      },
    },
    regions: { aws: ['ap-northeast-1'] },
  },
  scoring: {
    type: 'lambda' as const,
    path: 'handler',
    timeoutMinutes: 5,
    criteria: [{ name: '正解', weight: 1, maxPoints: 100 }],
  },
};

const unsupportedTeamDeployProblem = {
  ...baseProblem,
  id: 'prob-unsupported',
  title: 'JAM 問題',
  type: 'jam' as const,
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

  it('問題ごとにデプロイボタンを表示すべき', async () => {
    mockGetEventProblems.mockResolvedValue({ problems: [baseProblem] });
    render(<AdminEventProblemsPage />);

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'デプロイ' }),
      ).toBeInTheDocument();
    });
  });

  it('デプロイボタンクリックでデプロイモーダルを表示すべき', async () => {
    mockGetEventProblems.mockResolvedValue({ problems: [baseProblem] });
    render(<AdminEventProblemsPage />);

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'デプロイ' }),
      ).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole('button', { name: 'デプロイ' }));

    await waitFor(() => {
      expect(screen.getByText(/デプロイ:/)).toBeInTheDocument();
      expect(screen.getByText('リージョン')).toBeInTheDocument();
    });
  });

  it('デプロイモーダルでドライランオプションを表示すべき', async () => {
    mockGetEventProblems.mockResolvedValue({ problems: [baseProblem] });
    render(<AdminEventProblemsPage />);

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'デプロイ' }),
      ).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole('button', { name: 'デプロイ' }));

    await waitFor(() => {
      expect(
        screen.getByText('テンプレートの検証のみ（実際のデプロイは行わない）'),
      ).toBeInTheDocument();
    });
  });

  it('デプロイ実行後にステータスを表示すべき', async () => {
    mockGetEventProblems.mockResolvedValue({ problems: [baseProblem] });
    mockDeployProblem.mockResolvedValue({
      stackName: 'test-stack',
      message: 'deployed',
    });
    mockGetDeploymentStatus.mockResolvedValue({
      stackName: 'test-stack',
      status: 'CREATE_COMPLETE',
    });

    render(<AdminEventProblemsPage />);

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'デプロイ' }),
      ).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole('button', { name: 'デプロイ' }));

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'デプロイ実行' }),
      ).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole('button', { name: 'デプロイ実行' }));

    await waitFor(() => {
      expect(mockDeployProblem).toHaveBeenCalledWith('prob-1', {
        region: 'ap-northeast-1',
        dryRun: false,
      });
    });
  });

  it('取得エラー時にエラーメッセージを表示すべき', async () => {
    mockGetEventProblems.mockRejectedValue(new Error('取得失敗'));
    render(<AdminEventProblemsPage />);

    await waitFor(() => {
      expect(screen.getByText('取得失敗')).toBeInTheDocument();
    });
  });

  it('デプロイカラムのヘッダーを表示すべき', async () => {
    mockGetEventProblems.mockResolvedValue({ problems: [baseProblem] });
    render(<AdminEventProblemsPage />);

    await waitFor(() => {
      expect(screen.getAllByText('デプロイ').length).toBeGreaterThanOrEqual(1);
    });
  });

  it('対応している問題ではチームデプロイ画面へ遷移できるべき', async () => {
    mockGetEventProblems.mockResolvedValue({ problems: [baseProblem] });
    render(<AdminEventProblemsPage />);

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'チームへデプロイ' }),
      ).toBeInTheDocument();
    });

    await userEvent.click(
      screen.getByRole('button', { name: 'チームへデプロイ' }),
    );

    expect(mockPush).toHaveBeenCalledWith(
      '/admin/events/ev-1/problems/prob-1/deployments',
    );
  });

  it('未対応の問題ではチームデプロイ理由を表示すべき', async () => {
    mockGetEventProblems.mockResolvedValue({
      problems: [unsupportedTeamDeployProblem],
    });
    render(<AdminEventProblemsPage />);

    await waitFor(() => {
      expect(
        screen.getByText('GameDay 問題のみチーム配布に対応しています。'),
      ).toBeInTheDocument();
    });

    expect(
      screen.getByRole('button', { name: 'チームへデプロイ' }),
    ).toBeDisabled();
  });
});
