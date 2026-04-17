import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { DeploymentGate } from '../deployment-gate';

const mockDeploymentResult = {
  isReady: true,
  isChecking: false,
  status: { deployed: true, status: 'completed' } as {
    deployed: boolean;
    status: string;
  } | null,
  checkError: null,
};

vi.mock('@/lib/hooks/use-deployment-status', () => ({
  useDeploymentStatus: () => mockDeploymentResult,
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ eventId: 'ev-1' }),
}));

describe('DeploymentGate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeploymentResult.isReady = true;
    mockDeploymentResult.isChecking = false;
    mockDeploymentResult.status = { deployed: true, status: 'completed' };
    mockDeploymentResult.checkError = null;
  });

  it('デプロイ済みの場合は子要素を表示すべき', () => {
    render(
      <DeploymentGate eventId="ev-1">
        <div>テストコンテンツ</div>
      </DeploymentGate>,
    );

    expect(screen.getByText('テストコンテンツ')).toBeInTheDocument();
  });

  it('チェック中はスピナーを表示すべき', () => {
    mockDeploymentResult.isChecking = true;
    render(
      <DeploymentGate eventId="ev-1">
        <div>テストコンテンツ</div>
      </DeploymentGate>,
    );

    expect(screen.queryByText('テストコンテンツ')).not.toBeInTheDocument();
  });

  it('デプロイ未完了時に警告メッセージを表示すべき', () => {
    mockDeploymentResult.isReady = false;
    mockDeploymentResult.status = { deployed: false, status: 'pending' };
    render(
      <DeploymentGate eventId="ev-1">
        <div>テストコンテンツ</div>
      </DeploymentGate>,
    );

    expect(screen.queryByText('テストコンテンツ')).not.toBeInTheDocument();
    expect(
      screen.getByText(
        'The environment deployment has not been completed yet. Please contact your administrator.',
      ),
    ).toBeInTheDocument();
  });

  it('デプロイ中に進捗メッセージを表示すべき', () => {
    mockDeploymentResult.isReady = false;
    mockDeploymentResult.status = { deployed: false, status: 'in_progress' };
    render(
      <DeploymentGate eventId="ev-1">
        <div>テストコンテンツ</div>
      </DeploymentGate>,
    );

    expect(screen.queryByText('テストコンテンツ')).not.toBeInTheDocument();
    expect(
      screen.getByText(
        'The environment is being deployed. Please wait a moment.',
      ),
    ).toBeInTheDocument();
  });

  it('デプロイ失敗時にエラーメッセージを表示すべき', () => {
    mockDeploymentResult.isReady = false;
    mockDeploymentResult.status = { deployed: false, status: 'failed' };
    render(
      <DeploymentGate eventId="ev-1">
        <div>テストコンテンツ</div>
      </DeploymentGate>,
    );

    expect(screen.queryByText('テストコンテンツ')).not.toBeInTheDocument();
    expect(
      screen.getByText(
        'The environment deployment has failed. Please contact your administrator.',
      ),
    ).toBeInTheDocument();
  });

  it('ステータスが null の場合は子要素を表示すべき', () => {
    mockDeploymentResult.isReady = false;
    mockDeploymentResult.status = null;
    render(
      <DeploymentGate eventId="ev-1">
        <div>テストコンテンツ</div>
      </DeploymentGate>,
    );

    expect(screen.getByText('テストコンテンツ')).toBeInTheDocument();
  });
});
