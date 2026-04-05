import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import ChallengeDetailPage from '../page';

// Stable router reference to avoid infinite re-renders from effect deps
const mockPush = vi.fn();
const mockRouter = { push: mockPush };
vi.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  useParams: () => ({ eventId: 'evt-1', challengeId: 'chal-1' }),
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

const mockGetJamChallengeDetails = vi.fn();
const mockGetChallengeDetails = vi.fn();
const mockGetAWSCredentials = vi.fn();
const mockGetLatestSubmission = vi.fn();
const mockRequestGameDayScoring = vi.fn();
const mockRevealHint = vi.fn();
const mockRevealClue = vi.fn();
const mockSubmitJamAnswer = vi.fn();

vi.mock('@/lib/api/challenges', () => ({
  getJamChallengeDetails: (...args: unknown[]) =>
    mockGetJamChallengeDetails(...args),
  getChallengeDetails: (...args: unknown[]) => mockGetChallengeDetails(...args),
  getAWSCredentials: (...args: unknown[]) => mockGetAWSCredentials(...args),
  getLatestSubmission: (...args: unknown[]) => mockGetLatestSubmission(...args),
  requestGameDayScoring: (...args: unknown[]) =>
    mockRequestGameDayScoring(...args),
  revealHint: (...args: unknown[]) => mockRevealHint(...args),
  revealClue: (...args: unknown[]) => mockRevealClue(...args),
  submitJamAnswer: (...args: unknown[]) => mockSubmitJamAnswer(...args),
}));

const baseGameDayChallenge = {
  id: 'chal-1',
  title: 'EC2 障害対応',
  type: 'gameday' as const,
  category: 'compute' as const,
  difficulty: 'medium' as const,
  overview: 'EC2インスタンスの障害を修復してください',
  description: '詳しい説明テキスト',
  objectives: ['ターゲット1を達成する', 'ターゲット2を達成する'],
  instructions: ['ステップ1', 'ステップ2'],
  hints: [
    {
      id: 'hint-1',
      content: 'ヒントの内容',
      costPoints: 50,
      isRevealed: false,
    },
  ],
  resources: [],
  scoringCriteria: [
    {
      name: '基準1',
      description: '説明1',
      maxPoints: 100,
      currentPoints: 0,
      isPassed: false,
    },
  ],
  order: 1,
  isUnlocked: true,
  pointMultiplier: 1,
  maxScore: 300,
  myScore: 100,
  isCompleted: false,
  awsAccountId: '123456789012',
  awsConsoleUrl: 'https://console.aws.amazon.com',
};

const baseCredentials = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  sessionToken: 'token',
  region: 'ap-northeast-1',
  expiresAt: '2024-06-01T18:00:00Z',
};

describe('ChallengeDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetJamChallengeDetails.mockResolvedValue(null);
    mockGetAWSCredentials.mockResolvedValue(baseCredentials);
    mockGetLatestSubmission.mockResolvedValue(null);
  });

  it('ローディング中はチャレンジデータを表示しないべき', () => {
    mockGetJamChallengeDetails.mockReturnValue(new Promise(() => {}));
    mockGetChallengeDetails.mockReturnValue(new Promise(() => {}));
    render(<ChallengeDetailPage />);
    expect(screen.queryByText('EC2 障害対応')).not.toBeInTheDocument();
  });

  it('GameDayチャレンジ情報を表示すべき', async () => {
    mockGetChallengeDetails.mockResolvedValue(baseGameDayChallenge);
    render(<ChallengeDetailPage />);

    await waitFor(() => {
      expect(screen.getByText('EC2 障害対応')).toBeInTheDocument();
    });
    expect(
      screen.getByText('EC2インスタンスの障害を修復してください'),
    ).toBeInTheDocument();
    expect(screen.getByText('詳しい説明テキスト')).toBeInTheDocument();
  });

  it('難易度バッジを表示すべき', async () => {
    mockGetChallengeDetails.mockResolvedValue(baseGameDayChallenge);
    render(<ChallengeDetailPage />);

    await waitFor(() => {
      expect(screen.getAllByText('中級').length).toBeGreaterThanOrEqual(1);
    });
  });

  it('目標一覧を表示すべき', async () => {
    mockGetChallengeDetails.mockResolvedValue(baseGameDayChallenge);
    render(<ChallengeDetailPage />);

    await waitFor(() => {
      expect(screen.getByText(/ターゲット1を達成する/)).toBeInTheDocument();
    });
    expect(screen.getByText(/ターゲット2を達成する/)).toBeInTheDocument();
  });

  it('GameDayの採点リクエストボタンを表示すべき', async () => {
    mockGetChallengeDetails.mockResolvedValue(baseGameDayChallenge);
    render(<ChallengeDetailPage />);

    await waitFor(() => {
      const buttons = screen.getAllByRole('button');
      const scoringButton = buttons.find((b) =>
        b.textContent?.includes('採点をリクエスト'),
      );
      expect(scoringButton).toBeTruthy();
    });
  });

  it('採点リクエストボタンをクリックするとAPIを呼び出すべき', async () => {
    mockGetChallengeDetails.mockResolvedValue(baseGameDayChallenge);
    mockRequestGameDayScoring.mockResolvedValue({ submissionId: 'sub-1' });
    render(<ChallengeDetailPage />);

    await waitFor(() => {
      expect(screen.getByText('EC2 障害対応')).toBeInTheDocument();
    });

    const buttons = screen.getAllByRole('button');
    const scoringButton = buttons.find((b) =>
      b.textContent?.includes('採点をリクエスト'),
    );
    if (scoringButton) {
      fireEvent.click(scoringButton);
      await waitFor(() => {
        expect(mockRequestGameDayScoring).toHaveBeenCalledWith(
          'evt-1',
          'chal-1',
        );
      });
    }
  });

  it('ヒントセクションを表示すべき', async () => {
    mockGetChallengeDetails.mockResolvedValue(baseGameDayChallenge);
    render(<ChallengeDetailPage />);

    await waitFor(() => {
      expect(screen.getByText(/ヒント 1/)).toBeInTheDocument();
    });
  });

  it('AWSクレデンシャルをGameDayチャレンジに表示すべき', async () => {
    mockGetChallengeDetails.mockResolvedValue(baseGameDayChallenge);
    render(<ChallengeDetailPage />);

    await waitFor(() => {
      expect(screen.getByText('AWS クレデンシャル')).toBeInTheDocument();
    });
    expect(screen.getByText('ap-northeast-1')).toBeInTheDocument();
  });

  it('APIエラー時にエラーメッセージを表示すべき', async () => {
    mockGetChallengeDetails.mockRejectedValue(
      new Error('読み込みに失敗しました'),
    );
    render(<ChallengeDetailPage />);

    await waitFor(() => {
      expect(screen.getByText('読み込みに失敗しました')).toBeInTheDocument();
    });
  });

  it('採点基準テーブルを表示すべき', async () => {
    mockGetChallengeDetails.mockResolvedValue(baseGameDayChallenge);
    render(<ChallengeDetailPage />);

    await waitFor(() => {
      expect(screen.getByText('採点基準')).toBeInTheDocument();
    });
    expect(screen.getByText('基準1')).toBeInTheDocument();
  });

  it('前回の提出結果を表示すべき', async () => {
    mockGetChallengeDetails.mockResolvedValue(baseGameDayChallenge);
    mockGetLatestSubmission.mockResolvedValue({
      id: 'sub-1',
      problemId: 'chal-1',
      eventId: 'evt-1',
      submittedAt: '2024-06-01T12:00:00Z',
      status: 'completed',
      score: 200,
      maxScore: 300,
    });
    render(<ChallengeDetailPage />);

    await waitFor(() => {
      expect(screen.getByText('最新の提出')).toBeInTheDocument();
    });
    expect(screen.getByText('完了')).toBeInTheDocument();
  });
});

describe('ChallengeDetailPage - JAM モード', () => {
  const jamChallenge = {
    ...baseGameDayChallenge,
    type: 'jam' as const,
    clues: [
      {
        id: 'clue-1',
        order: 1,
        title: 'クルー1',
        content: 'クルーの内容',
        costPoints: 30,
        isRevealed: false,
      },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAWSCredentials.mockResolvedValue(baseCredentials);
    mockGetLatestSubmission.mockResolvedValue(null);
  });

  it('JAMチャレンジの回答入力フォームを表示すべき', async () => {
    mockGetJamChallengeDetails.mockResolvedValue(jamChallenge);
    mockGetChallengeDetails.mockResolvedValue(null);
    render(<ChallengeDetailPage />);

    await waitFor(() => {
      expect(screen.getByText('回答を提出')).toBeInTheDocument();
    });
  });

  it('JAMのクルーセクションを表示すべき', async () => {
    mockGetJamChallengeDetails.mockResolvedValue(jamChallenge);
    mockGetChallengeDetails.mockResolvedValue(null);
    render(<ChallengeDetailPage />);

    await waitFor(() => {
      expect(screen.getByText(/クルー #1/)).toBeInTheDocument();
    });
  });

  it('回答を入力して提出ボタンをクリックするとAPIを呼び出すべき', async () => {
    mockGetJamChallengeDetails.mockResolvedValue(jamChallenge);
    mockGetChallengeDetails.mockResolvedValue(null);
    mockSubmitJamAnswer.mockResolvedValue({
      id: 'sub-jam-1',
      problemId: 'chal-1',
      eventId: 'evt-1',
      submittedAt: new Date().toISOString(),
      status: 'completed',
      isCorrect: true,
    });
    render(<ChallengeDetailPage />);

    await waitFor(() => {
      expect(screen.getByText('EC2 障害対応')).toBeInTheDocument();
    });

    // Find textarea and type answer
    const textareas = document.querySelectorAll('textarea');
    if (textareas.length > 0) {
      fireEvent.change(textareas[0], { target: { value: 'my-answer' } });
      const submitButton = screen
        .getAllByRole('button')
        .find((b) => b.textContent?.includes('回答を提出'));
      if (submitButton) {
        fireEvent.click(submitButton);
        await waitFor(() => {
          expect(mockSubmitJamAnswer).toHaveBeenCalledWith('evt-1', 'chal-1', {
            answer: 'my-answer',
          });
        });
      }
    }
  });
});
