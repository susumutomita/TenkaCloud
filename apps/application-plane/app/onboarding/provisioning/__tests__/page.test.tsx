import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import ProvisioningPage from '../page';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

describe('ProvisioningPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  it('プロビジョニングステップが表示されるべき', () => {
    render(<ProvisioningPage />);
    expect(screen.getByText('環境を構築中...')).toBeInTheDocument();
    expect(screen.getByText('認証基盤の構築')).toBeInTheDocument();
    expect(screen.getByText('データベースの作成')).toBeInTheDocument();
    expect(screen.getByText('アプリケーションのデプロイ')).toBeInTheDocument();
    expect(screen.getByText('DNS の設定')).toBeInTheDocument();
  });

  it('TenkaCloud ロゴが表示されるべき', () => {
    render(<ProvisioningPage />);
    expect(screen.getByText('TenkaCloud')).toBeInTheDocument();
  });

  it('進捗メッセージが表示されるべき', () => {
    render(<ProvisioningPage />);
    expect(
      screen.getByText('あなたのテナント環境を準備しています')
    ).toBeInTheDocument();
  });

  it('ホームリンクが表示されるべき', () => {
    render(<ProvisioningPage />);
    const homeLink = screen.getByRole('link');
    expect(homeLink).toHaveAttribute('href', '/');
  });
});
