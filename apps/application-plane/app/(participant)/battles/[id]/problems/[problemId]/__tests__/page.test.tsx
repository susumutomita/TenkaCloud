import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import ProblemDetailPage from '../page';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  useParams: () => ({ id: 'battle-1', problemId: 'prob-1' }),
}));

vi.mock('next-auth/react', () => ({
  SessionProvider: ({ children }: { children: React.ReactNode }) => children,
  useSession: () => ({ data: null, status: 'unauthenticated' }),
  getSession: vi.fn().mockResolvedValue(null),
}));

const mockGetChallengeDetails = vi.fn();
const mockRevealHint = vi.fn();

vi.mock('@/lib/api/challenges', () => ({
  getChallengeDetails: (...args: unknown[]) => mockGetChallengeDetails(...args),
  revealHint: (...args: unknown[]) => mockRevealHint(...args),
}));

const baseProblem = {
  id: 'prob-1',
  title: 'S3 バケット構築',
  type: 'gameday' as const,
  category: 'architecture' as const,
  difficulty: 'easy' as const,
  overview: 'S3 バケットを作成する課題',
  description: 'Amazon S3 バケットをセキュアに構築してください。',
  objectives: ['バケットを作成する', 'バージョニングを有効化する'],
  instructions: ['AWS コンソールにログイン', 'S3 に移動'],
  order: 1,
  isUnlocked: true,
  pointMultiplier: 1,
  maxScore: 100,
  myScore: 50,
  isCompleted: false,
  hints: [
    {
      id: 'hint-1',
      content: 'バケットポリシーを確認',
      costPoints: 10,
      isRevealed: false,
    },
    {
      id: 'hint-2',
      content: '暗号化を有効化',
      costPoints: 20,
      isRevealed: true,
    },
  ],
  resources: [
    {
      name: 'AWS S3 ドキュメント',
      type: 'link' as const,
      url: 'https://docs.aws.amazon.com/s3/',
    },
  ],
  scoringCriteria: [
    {
      name: 'バケット作成',
      description: 'S3 バケットが正しく作成されている',
      maxPoints: 50,
      currentPoints: 50,
      isPassed: true,
    },
    {
      name: 'バージョニング',
      description: 'バージョニングが有効化されている',
      maxPoints: 50,
      currentPoints: 0,
      isPassed: false,
    },
  ],
};

describe('問題詳細ページ', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('問題タイトルが表示されるべき', async () => {
    mockGetChallengeDetails.mockResolvedValue(baseProblem);
    render(<ProblemDetailPage />);
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: 'S3 バケット構築' }),
      ).toBeInTheDocument();
    });
  });

  it('ローディングスピナーが初期表示されるべき', () => {
    mockGetChallengeDetails.mockReturnValue(new Promise(() => {}));
    render(<ProblemDetailPage />);
    expect(document.querySelector('.animate-spin')).toBeInTheDocument();
  });

  it('問題が見つからない場合にリダイレクトすべき', async () => {
    mockGetChallengeDetails.mockResolvedValue(null);
    render(<ProblemDetailPage />);
    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/battles/battle-1/problems');
    });
  });

  it('目標が表示されるべき', async () => {
    mockGetChallengeDetails.mockResolvedValue(baseProblem);
    render(<ProblemDetailPage />);
    await waitFor(() => {
      expect(screen.getByText('目標')).toBeInTheDocument();
      expect(screen.getByText('バケットを作成する')).toBeInTheDocument();
      expect(
        screen.getByText('バージョニングを有効化する'),
      ).toBeInTheDocument();
    });
  });

  it('手順が表示されるべき', async () => {
    mockGetChallengeDetails.mockResolvedValue(baseProblem);
    render(<ProblemDetailPage />);
    await waitFor(() => {
      expect(screen.getByText('手順')).toBeInTheDocument();
      expect(screen.getByText('AWS コンソールにログイン')).toBeInTheDocument();
    });
  });

  it('未公開ヒントに「公開する」ボタンが表示されるべき', async () => {
    mockGetChallengeDetails.mockResolvedValue(baseProblem);
    render(<ProblemDetailPage />);
    await waitFor(() => {
      expect(screen.getByText('公開する')).toBeInTheDocument();
    });
  });

  it('公開済みヒントの内容が表示されるべき', async () => {
    mockGetChallengeDetails.mockResolvedValue(baseProblem);
    render(<ProblemDetailPage />);
    await waitFor(() => {
      expect(screen.getByText('暗号化を有効化')).toBeInTheDocument();
      expect(screen.getByText('公開済み')).toBeInTheDocument();
    });
  });

  it('採点基準が表示されるべき', async () => {
    mockGetChallengeDetails.mockResolvedValue(baseProblem);
    render(<ProblemDetailPage />);
    await waitFor(() => {
      expect(screen.getByText('採点基準')).toBeInTheDocument();
      expect(screen.getByText('バケット作成')).toBeInTheDocument();
      expect(screen.getByText('バージョニング')).toBeInTheDocument();
    });
  });

  it('参考資料が表示されるべき', async () => {
    mockGetChallengeDetails.mockResolvedValue(baseProblem);
    render(<ProblemDetailPage />);
    await waitFor(() => {
      expect(screen.getByText('参考資料')).toBeInTheDocument();
      expect(screen.getByText('AWS S3 ドキュメント')).toBeInTheDocument();
    });
  });

  it('スコアが表示されるべき', async () => {
    mockGetChallengeDetails.mockResolvedValue(baseProblem);
    render(<ProblemDetailPage />);
    await waitFor(() => {
      expect(screen.getByText('50')).toBeInTheDocument();
      expect(screen.getByText('/ 100 pts')).toBeInTheDocument();
    });
  });

  it('パンくずリストが表示されるべき', async () => {
    mockGetChallengeDetails.mockResolvedValue(baseProblem);
    render(<ProblemDetailPage />);
    await waitFor(() => {
      expect(screen.getByText('バトル一覧')).toBeInTheDocument();
      expect(screen.getByText('問題一覧')).toBeInTheDocument();
    });
  });
});
