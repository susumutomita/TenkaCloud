import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import OnboardingPage from '../page';

// Mock next/navigation
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

  it('次のステップに進めるべき', () => {
    render(<OnboardingPage />);
    const nextButton = screen.getByRole('button', { name: /次へ/ });
    fireEvent.click(nextButton);
    expect(screen.getByText('プラン選択')).toBeInTheDocument();
    expect(screen.getByText('Free')).toBeInTheDocument();
    expect(screen.getByText('Pro')).toBeInTheDocument();
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
});
