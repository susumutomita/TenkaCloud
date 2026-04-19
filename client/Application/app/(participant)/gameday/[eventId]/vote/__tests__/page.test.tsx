import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import VotePage from '../page';

vi.mock('next/navigation', () => ({
  useParams: () => ({ eventId: 'ev-1' }),
}));

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: null, status: 'unauthenticated' }),
}));

vi.mock('@/lib/hooks/use-gameday-session', () => ({
  useGamedaySession: () => ({
    eventId: 'ev-1',
    teamId: 'team-1',
    teamName: 'TeamAlpha',
  }),
}));

const mockDeploymentResult = {
  isReady: true,
  isChecking: false,
  status: { deployed: true, status: 'completed' },
  checkError: null,
};

vi.mock('@/lib/hooks/use-deployment-status', () => ({
  useDeploymentStatus: () => mockDeploymentResult,
}));

const mockGetVotingResults = vi.fn();
const mockSubmitVote = vi.fn();
const mockGetParticipantTeams = vi.fn();
vi.mock('@/lib/api/gameday', () => ({
  getParticipantTeams: (...args: unknown[]) => mockGetParticipantTeams(...args),
  getVotingResults: (...args: unknown[]) => mockGetVotingResults(...args),
  submitVote: (...args: unknown[]) => mockSubmitVote(...args),
}));

const baseTeamsResponse = {
  teams: [
    { teamId: 'team-1', teamName: 'TeamAlpha' },
    { teamId: 'team-2', teamName: 'TeamBeta' },
    { teamId: 'team-3', teamName: 'TeamGamma' },
  ],
};

const baseVotingResults = {
  results: [],
};

describe('VotePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetParticipantTeams.mockResolvedValue(baseTeamsResponse);
    mockGetVotingResults.mockResolvedValue(baseVotingResults);
    // デプロイ済みをデフォルトにする
    mockDeploymentResult.isReady = true;
    mockDeploymentResult.isChecking = false;
    mockDeploymentResult.status = { deployed: true, status: 'completed' };
    mockDeploymentResult.checkError = null;
  });

  it('ローディング中はチームデータを表示しないべき', () => {
    mockGetVotingResults.mockReturnValue(new Promise(() => {}));
    render(<VotePage />);
    expect(screen.queryByText('TeamBeta')).not.toBeInTheDocument();
  });

  it('他チームのカードを表示すべき', async () => {
    render(<VotePage />);

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: /Vote targets/ }),
      ).toBeInTheDocument();
    });
    expect(screen.getAllByText('TeamBeta').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('TeamGamma').length).toBeGreaterThanOrEqual(1);
    // 自チームは表示しない
    expect(screen.queryAllByText('TeamAlpha')).toHaveLength(0);
  });

  it('他チームへの投票ボタンを表示すべき', async () => {
    render(<VotePage />);

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /Vote/i })).toHaveLength(2);
    });

    const voteButtons = screen.getAllByRole('button', { name: /Vote/i });
    expect(voteButtons).toHaveLength(2);
  });

  it('APIエラー時にエラーメッセージを表示すべき', async () => {
    mockGetVotingResults.mockRejectedValue(new Error('読み込みに失敗しました'));
    render(<VotePage />);

    await waitFor(() => {
      expect(screen.getByText('読み込みに失敗しました')).toBeInTheDocument();
    });
  });

  it('投票済みの場合は投票完了メッセージを表示すべき', async () => {
    mockGetVotingResults.mockResolvedValue({
      results: [{ voterTeamId: 'team-1', votedForTeamId: 'team-2' }],
    });
    render(<VotePage />);

    await waitFor(() => {
      expect(
        screen.getByText(/Your vote has been submitted/),
      ).toBeInTheDocument();
    });
  });

  it('チームがない場合は空状態メッセージを表示すべき', async () => {
    mockGetParticipantTeams.mockResolvedValue({
      teams: [{ teamId: 'team-1', teamName: 'TeamAlpha' }],
    });
    render(<VotePage />);

    await waitFor(() => {
      expect(
        screen.getAllByText('No other teams are registered yet.').length,
      ).toBeGreaterThanOrEqual(1);
    });
  });

  it('投票するボタンクリックで submitVote を呼ぶべき', async () => {
    mockSubmitVote.mockResolvedValue({});
    render(<VotePage />);

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /Vote/i })).toHaveLength(2);
    });

    const voteButtons = screen.getAllByRole('button', { name: /Vote/i });
    fireEvent.click(voteButtons[0]);

    await waitFor(() => {
      expect(mockSubmitVote).toHaveBeenCalledWith('ev-1', 'team-1', 'team-2');
    });
  });

  it('デプロイ未完了時に警告メッセージを表示すべき', async () => {
    mockDeploymentResult.isReady = false;
    mockDeploymentResult.status = {
      deployed: false,
      status: 'pending',
    };
    render(<VotePage />);

    await waitFor(() => {
      expect(
        screen.getByText(
          'The environment deployment has not been completed yet. Please contact your administrator.',
        ),
      ).toBeInTheDocument();
    });
  });

  it('デプロイ中に進捗メッセージを表示すべき', async () => {
    mockDeploymentResult.isReady = false;
    mockDeploymentResult.status = {
      deployed: false,
      status: 'in_progress',
    };
    render(<VotePage />);

    await waitFor(() => {
      expect(
        screen.getByText(
          'The environment is being deployed. Please wait a moment.',
        ),
      ).toBeInTheDocument();
    });
  });

  it('デプロイ失敗時にエラーメッセージを表示すべき', async () => {
    mockDeploymentResult.isReady = false;
    mockDeploymentResult.status = {
      deployed: false,
      status: 'failed',
    };
    render(<VotePage />);

    await waitFor(() => {
      expect(
        screen.getByText(
          'The environment deployment has failed. Please contact your administrator.',
        ),
      ).toBeInTheDocument();
    });
  });
});
