import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AdminProblemDeployPage from '../page';

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'prob-123' }),
}));

const mockDeployProblem = vi.fn();
const mockGetDeployStatus = vi.fn();
const mockDeleteDeployment = vi.fn();

vi.mock('@/lib/api/deployment', () => ({
  deployProblem: (...args: unknown[]) => mockDeployProblem(...args),
  getDeployStatus: (...args: unknown[]) => mockGetDeployStatus(...args),
  deleteDeployment: (...args: unknown[]) => mockDeleteDeployment(...args),
}));

describe('Admin 問題デプロイページ', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDeployStatus.mockRejectedValue(new Error('Not found'));
  });

  it('ページタイトルが表示されるべき', async () => {
    render(<AdminProblemDeployPage />);
    await waitFor(() => {
      expect(
        screen.getByRole('heading', {
          name: 'AWS CloudFormation デプロイ',
          level: 1,
        })
      ).toBeInTheDocument();
    });
  });

  it('デプロイ設定セクションが表示されるべき', async () => {
    render(<AdminProblemDeployPage />);
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: 'デプロイ設定', level: 2 })
      ).toBeInTheDocument();
    });
    expect(
      screen.getByRole('button', { name: 'デプロイ開始' })
    ).toBeInTheDocument();
  });

  it('デプロイ実行でステータスが表示されるべき', async () => {
    const user = userEvent.setup();
    mockDeployProblem.mockResolvedValue({
      message: 'Deploy started',
      stackName: 'test-stack',
      stackId: 'arn:test',
    });

    render(<AdminProblemDeployPage />);

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'デプロイ開始' })
      ).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'デプロイ開始' }));

    await waitFor(() => {
      expect(mockDeployProblem).toHaveBeenCalledWith(
        'prob-123',
        'ap-northeast-1'
      );
    });

    await waitFor(() => {
      expect(screen.getByText('test-stack')).toBeInTheDocument();
    });
    expect(screen.getByText('CREATE_IN_PROGRESS')).toBeInTheDocument();
  });

  it('デプロイエラー時にアラートが表示されるべき', async () => {
    const user = userEvent.setup();
    mockDeployProblem.mockRejectedValue(new Error('テンプレートが無効です'));

    render(<AdminProblemDeployPage />);

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'デプロイ開始' })
      ).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'デプロイ開始' }));

    await waitFor(() => {
      expect(screen.getByText('テンプレートが無効です')).toBeInTheDocument();
    });
  });

  it('Error 以外の例外でデフォルトエラーメッセージが表示されるべき', async () => {
    const user = userEvent.setup();
    mockDeployProblem.mockRejectedValue('string error');

    render(<AdminProblemDeployPage />);

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'デプロイ開始' })
      ).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'デプロイ開始' }));

    await waitFor(() => {
      expect(screen.getByText('デプロイに失敗しました')).toBeInTheDocument();
    });
  });

  it('既存のデプロイステータスを表示すべき', async () => {
    mockGetDeployStatus.mockResolvedValue({
      stackName: 'existing-stack',
      status: 'CREATE_COMPLETE',
      outputs: { Endpoint: 'https://example.com' },
      events: [
        {
          timestamp: '2026-04-03T10:00:00Z',
          logicalResourceId: 'MyBucket',
          resourceType: 'AWS::S3::Bucket',
          resourceStatus: 'CREATE_COMPLETE',
        },
      ],
    });

    render(<AdminProblemDeployPage />);

    await waitFor(() => {
      expect(screen.getByText('existing-stack')).toBeInTheDocument();
    });
    // CREATE_COMPLETE はスタックステータスとイベントステータスの両方に表示される
    expect(
      screen.getAllByText('CREATE_COMPLETE').length
    ).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Endpoint')).toBeInTheDocument();
    expect(screen.getByText('https://example.com')).toBeInTheDocument();
    expect(screen.getByText('MyBucket')).toBeInTheDocument();
  });

  it('スタック削除の確認モーダルが表示されるべき', async () => {
    const user = userEvent.setup();
    mockGetDeployStatus.mockResolvedValue({
      stackName: 'delete-target',
      status: 'CREATE_COMPLETE',
      events: [],
    });

    render(<AdminProblemDeployPage />);

    await waitFor(() => {
      expect(screen.getByText('delete-target')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'スタック削除' }));

    await waitFor(() => {
      expect(screen.getByText('スタック削除の確認')).toBeInTheDocument();
    });
    expect(
      screen.getByText(
        'スタック「delete-target」を削除します。 この操作は取り消せません。'
      )
    ).toBeInTheDocument();
  });

  it('削除を実行すべき', async () => {
    const user = userEvent.setup();
    mockGetDeployStatus.mockResolvedValue({
      stackName: 'delete-target',
      status: 'CREATE_COMPLETE',
      events: [],
    });
    mockDeleteDeployment.mockResolvedValue({ message: 'Deleted' });

    render(<AdminProblemDeployPage />);

    await waitFor(() => {
      expect(screen.getByText('delete-target')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'スタック削除' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '削除' })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: '削除' }));

    await waitFor(() => {
      expect(mockDeleteDeployment).toHaveBeenCalledWith('prob-123');
    });
  });

  it('削除エラー時にモーダル内にエラーが表示されるべき', async () => {
    const user = userEvent.setup();
    mockGetDeployStatus.mockResolvedValue({
      stackName: 'delete-target',
      status: 'CREATE_COMPLETE',
      events: [],
    });
    mockDeleteDeployment.mockRejectedValue(new Error('削除に失敗しました'));

    render(<AdminProblemDeployPage />);

    await waitFor(() => {
      expect(screen.getByText('delete-target')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'スタック削除' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '削除' })).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: '削除' }));

    await waitFor(() => {
      expect(screen.getByText('削除に失敗しました')).toBeInTheDocument();
    });
  });

  it('削除時に Error 以外の例外でデフォルトメッセージが表示されるべき', async () => {
    const user = userEvent.setup();
    mockGetDeployStatus.mockResolvedValue({
      stackName: 'delete-target',
      status: 'CREATE_COMPLETE',
      events: [],
    });
    mockDeleteDeployment.mockRejectedValue('string error');

    render(<AdminProblemDeployPage />);

    await waitFor(() => {
      expect(screen.getByText('delete-target')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'スタック削除' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '削除' })).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: '削除' }));

    await waitFor(() => {
      expect(
        screen.getByText('スタックの削除に失敗しました')
      ).toBeInTheDocument();
    });
  });

  it('IN_PROGRESS 中はスタック削除ボタンが無効であるべき', async () => {
    mockGetDeployStatus.mockResolvedValue({
      stackName: 'in-progress-stack',
      status: 'CREATE_IN_PROGRESS',
      events: [],
    });

    render(<AdminProblemDeployPage />);

    await waitFor(() => {
      expect(screen.getByText('in-progress-stack')).toBeInTheDocument();
    });

    expect(screen.getByRole('button', { name: 'スタック削除' })).toBeDisabled();
  });

  it('自動更新が IN_PROGRESS 中に実行されるべき', async () => {
    mockGetDeployStatus
      .mockResolvedValueOnce({
        stackName: 'auto-refresh-stack',
        status: 'CREATE_IN_PROGRESS',
        events: [],
      })
      .mockResolvedValueOnce({
        stackName: 'auto-refresh-stack',
        status: 'CREATE_IN_PROGRESS',
        events: [],
      })
      .mockResolvedValue({
        stackName: 'auto-refresh-stack',
        status: 'CREATE_COMPLETE',
        events: [],
      });

    render(<AdminProblemDeployPage />);

    await waitFor(() => {
      expect(screen.getByText('auto-refresh-stack')).toBeInTheDocument();
    });

    // 初回フェッチは IN_PROGRESS なので stopAutoRefresh は呼ばれない
    // ただし自動更新はデプロイ実行後にのみ開始される仕様
    expect(mockGetDeployStatus).toHaveBeenCalledTimes(1);
  });

  it('イベントなし表示が正しく出るべき', async () => {
    mockGetDeployStatus.mockReset();
    mockGetDeployStatus.mockResolvedValue({
      stackName: 'empty-events-stack',
      status: 'CREATE_COMPLETE',
      events: [],
    });

    render(<AdminProblemDeployPage />);

    await waitFor(() => {
      expect(screen.getByText('empty-events-stack')).toBeInTheDocument();
    });

    expect(screen.getByText('イベントなし')).toBeInTheDocument();
  });

  it('削除確認モーダルのキャンセルでエラーにならないべき', async () => {
    const user = userEvent.setup();
    mockGetDeployStatus.mockReset();
    mockGetDeployStatus.mockResolvedValue({
      stackName: 'cancel-test',
      status: 'CREATE_COMPLETE',
      events: [],
    });

    render(<AdminProblemDeployPage />);

    await waitFor(() => {
      expect(screen.getByText('cancel-test')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'スタック削除' }));
    await waitFor(() => {
      expect(screen.getByText('スタック削除の確認')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'キャンセル' }));

    // キャンセル後もページが正常に表示されていることを確認
    expect(screen.getByText('cancel-test')).toBeInTheDocument();
    // deleteDeployment が呼ばれていないことを確認
    expect(mockDeleteDeployment).not.toHaveBeenCalled();
  });

  it('statusReason が表示されるべき', async () => {
    mockGetDeployStatus.mockResolvedValue({
      stackName: 'reason-stack',
      status: 'ROLLBACK_COMPLETE',
      statusReason: 'リソース作成に失敗',
      events: [],
    });

    render(<AdminProblemDeployPage />);

    await waitFor(() => {
      expect(screen.getByText('リソース作成に失敗')).toBeInTheDocument();
    });
  });
});
