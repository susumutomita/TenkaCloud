import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import ProblemsPage from '../page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useParams: () => ({ id: 'battle-1' }),
}));

vi.mock('next-auth/react', () => ({
  SessionProvider: ({ children }: { children: React.ReactNode }) => children,
  useSession: () => ({ data: null, status: 'unauthenticated' }),
  getSession: vi.fn().mockResolvedValue(null),
}));

const mockGetEventDetails = vi.fn();
vi.mock('@/lib/api/events', () => ({
  getEventDetails: (...args: unknown[]) => mockGetEventDetails(...args),
}));

const battleWithProblems = {
  id: 'battle-1',
  name: 'AWS GameDay 2025',
  type: 'gameday' as const,
  status: 'active' as const,
  startTime: '2025-01-01T09:00:00Z',
  endTime: '2025-01-01T17:00:00Z',
  timezone: 'Asia/Tokyo',
  participantType: 'individual' as const,
  cloudProvider: 'aws' as const,
  regions: ['ap-northeast-1'],
  scoringType: 'realtime' as const,
  leaderboardVisible: true,
  problemCount: 2,
  participantCount: 42,
  isRegistered: true,
  problems: [
    {
      id: 'prob-1',
      title: 'S3 バケット構築',
      type: 'gameday' as const,
      category: 'architecture' as const,
      difficulty: 'easy' as const,
      overview: 'S3 バケットを作成する課題',
      objectives: ['バケットを作成'],
      order: 1,
      isUnlocked: true,
      pointMultiplier: 1,
      maxScore: 100,
      isCompleted: false,
    },
    {
      id: 'prob-2',
      title: 'VPC 構築',
      type: 'gameday' as const,
      category: 'security' as const,
      difficulty: 'medium' as const,
      overview: 'VPC を構築する課題',
      objectives: ['VPC を作成'],
      order: 2,
      isUnlocked: false,
      pointMultiplier: 2,
      maxScore: 200,
      isCompleted: false,
    },
  ],
};

describe('問題一覧ページ', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ページタイトルに問題数が表示されるべき', async () => {
    mockGetEventDetails.mockResolvedValue(battleWithProblems);
    render(<ProblemsPage />);
    await waitFor(() => {
      expect(screen.getByText('問題一覧 (2問)')).toBeInTheDocument();
    });
  });

  it('ローディングスピナーが初期表示されるべき', () => {
    mockGetEventDetails.mockReturnValue(new Promise(() => {}));
    render(<ProblemsPage />);
    expect(document.querySelector('.animate-spin')).toBeInTheDocument();
  });

  it('問題名が表示されるべき', async () => {
    mockGetEventDetails.mockResolvedValue(battleWithProblems);
    render(<ProblemsPage />);
    await waitFor(() => {
      expect(screen.getByText('S3 バケット構築')).toBeInTheDocument();
      expect(screen.getByText('VPC 構築')).toBeInTheDocument();
    });
  });

  it('ロック中の問題に「ロック中」バッジが表示されるべき', async () => {
    mockGetEventDetails.mockResolvedValue(battleWithProblems);
    render(<ProblemsPage />);
    await waitFor(() => {
      expect(screen.getByText('ロック中')).toBeInTheDocument();
    });
  });

  it('問題がないときに空状態メッセージが表示されるべき', async () => {
    mockGetEventDetails.mockResolvedValue({
      ...battleWithProblems,
      problems: [],
      problemCount: 0,
    });
    render(<ProblemsPage />);
    await waitFor(() => {
      expect(screen.getByText('まだ問題がありません')).toBeInTheDocument();
    });
  });

  it('エラー時にエラー表示されるべき', async () => {
    mockGetEventDetails.mockRejectedValue(new Error('Failed to fetch'));
    render(<ProblemsPage />);
    await waitFor(() => {
      expect(screen.getByText('再試行')).toBeInTheDocument();
    });
  });

  it('パンくずリストが表示されるべき', async () => {
    mockGetEventDetails.mockResolvedValue(battleWithProblems);
    render(<ProblemsPage />);
    await waitFor(() => {
      // Breadcrumb links
      const links = screen.getAllByRole('link');
      const battleListLink = links.find((l) => l.textContent === 'バトル一覧');
      expect(battleListLink).toBeDefined();
      expect(battleListLink).toHaveAttribute('href', '/battles');
    });
  });

  it('問題の配点が表示されるべき', async () => {
    mockGetEventDetails.mockResolvedValue(battleWithProblems);
    render(<ProblemsPage />);
    await waitFor(() => {
      expect(screen.getByText('100')).toBeInTheDocument();
      expect(screen.getByText('400')).toBeInTheDocument(); // 200 * 2
    });
  });
});
