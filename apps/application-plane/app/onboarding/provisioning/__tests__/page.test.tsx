import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ProvisioningPage from '../page';

// Mock next/navigation
const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

describe('ProvisioningPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('プロビジョニングステップが表示されるべき', () => {
    render(<ProvisioningPage />);
    expect(screen.getByText('環境を構築中...')).toBeInTheDocument();
    expect(screen.getByText('認証基盤の構築')).toBeInTheDocument();
    expect(screen.getByText('データベースの作成')).toBeInTheDocument();
    expect(screen.getByText('アプリケーションのデプロイ')).toBeInTheDocument();
    expect(screen.getByText('DNS の設定')).toBeInTheDocument();
  });
});
