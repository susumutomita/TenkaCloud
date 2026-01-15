import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import OnboardingPage from '../page';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

describe('OnboardingPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('オンボーディングウィザードが表示されるべき', () => {
    render(<OnboardingPage />);
    expect(screen.getByText('セットアップ')).toBeInTheDocument();
    expect(screen.getByText('プロフィール')).toBeInTheDocument();
  });

  it('組織名と役割フィールドが表示されるべき', () => {
    render(<OnboardingPage />);
    expect(screen.getByText('組織名')).toBeInTheDocument();
    expect(screen.getByText('役割')).toBeInTheDocument();
  });

  it('次のステップに進めるべき', () => {
    render(<OnboardingPage />);
    fireEvent.click(screen.getByRole('button', { name: /次へ/ }));
    expect(screen.getByText('プラン選択')).toBeInTheDocument();
    expect(screen.getByText('Free')).toBeInTheDocument();
    expect(screen.getByText('Pro')).toBeInTheDocument();
    expect(screen.getByText('Enterprise')).toBeInTheDocument();
  });

  it('前のステップに戻れるべき', () => {
    render(<OnboardingPage />);
    fireEvent.click(screen.getByRole('button', { name: /次へ/ }));
    expect(screen.getByText('プラン選択')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /戻る/ }));
    expect(screen.getByText('プロフィール')).toBeInTheDocument();
  });

  it('プランを選択できるべき', () => {
    render(<OnboardingPage />);
    fireEvent.click(screen.getByRole('button', { name: /次へ/ }));
    const proButton = screen.getByText('Pro').closest('button');
    fireEvent.click(proButton!);
    expect(proButton).toHaveClass('border-hn-accent');
  });

  it('テナント設定ステップが表示されるべき', () => {
    render(<OnboardingPage />);
    fireEvent.click(screen.getByRole('button', { name: /次へ/ }));
    fireEvent.click(screen.getByRole('button', { name: /次へ/ }));
    expect(screen.getByText('テナント設定')).toBeInTheDocument();
    expect(screen.getByText('テナント名')).toBeInTheDocument();
    expect(screen.getByText('スラッグ')).toBeInTheDocument();
  });

  it('テナント名を入力するとスラッグが自動生成されるべき', () => {
    render(<OnboardingPage />);
    fireEvent.click(screen.getByRole('button', { name: /次へ/ }));
    fireEvent.click(screen.getByRole('button', { name: /次へ/ }));
    const inputs = screen.getAllByRole('textbox');
    fireEvent.change(inputs[0], { target: { value: 'My Team Name' } });
    expect(inputs[1]).toHaveValue('my-team-name');
  });

  it('確認ステップが表示されるべき', () => {
    render(<OnboardingPage />);
    fireEvent.click(screen.getByRole('button', { name: /次へ/ }));
    fireEvent.click(screen.getByRole('button', { name: /次へ/ }));
    fireEvent.click(screen.getByRole('button', { name: /次へ/ }));
    expect(screen.getByText('確認')).toBeInTheDocument();
    expect(screen.getByText('環境を作成')).toBeInTheDocument();
  });

  it('環境作成ボタンクリックでプロビジョニングへ遷移するべき', async () => {
    render(<OnboardingPage />);
    fireEvent.click(screen.getByRole('button', { name: /次へ/ }));
    fireEvent.click(screen.getByRole('button', { name: /次へ/ }));
    fireEvent.click(screen.getByRole('button', { name: /次へ/ }));
    fireEvent.click(screen.getByRole('button', { name: /環境を作成/ }));
    await waitFor(
      () => {
        expect(mockPush).toHaveBeenCalledWith('/onboarding/provisioning');
      },
      { timeout: 2000 }
    );
  });

  it('最初のステップでは戻るボタンが無効になるべき', () => {
    render(<OnboardingPage />);
    const backButton = screen.getByRole('button', { name: /戻る/ });
    expect(backButton).toBeDisabled();
  });

  it('プログレスインジケーターが表示されるべき', () => {
    render(<OnboardingPage />);
    const progressSteps = document.querySelectorAll('[class*="rounded-full"]');
    expect(progressSteps.length).toBeGreaterThan(0);
  });

  it('Proプランにおすすめバッジが表示されるべき', () => {
    render(<OnboardingPage />);
    fireEvent.click(screen.getByRole('button', { name: /次へ/ }));
    expect(screen.getByText('おすすめ')).toBeInTheDocument();
  });

  it('確認ステップで入力内容が表示されるべき', () => {
    render(<OnboardingPage />);
    const inputs = screen.getAllByRole('textbox');
    fireEvent.change(inputs[0], { target: { value: 'Test Org' } });
    fireEvent.click(screen.getByRole('button', { name: /次へ/ }));
    fireEvent.click(screen.getByRole('button', { name: /次へ/ }));
    const tenantInputs = screen.getAllByRole('textbox');
    fireEvent.change(tenantInputs[0], { target: { value: 'My Tenant' } });
    fireEvent.click(screen.getByRole('button', { name: /次へ/ }));
    expect(screen.getByText('Test Org')).toBeInTheDocument();
    expect(screen.getByText('My Tenant')).toBeInTheDocument();
  });
});
