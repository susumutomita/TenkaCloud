import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import SignupPage from '../page';

// Mock next/navigation
const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

describe('SignupPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('サインアップフォームが表示されるべき', () => {
    render(<SignupPage />);
    expect(screen.getByText('アカウント作成')).toBeInTheDocument();
    expect(screen.getByText('名前')).toBeInTheDocument();
    expect(screen.getByText('メールアドレス')).toBeInTheDocument();
    expect(screen.getByText(/^パスワード$/)).toBeInTheDocument();
  });

  it('ソーシャルログインボタンが表示されるべき', () => {
    render(<SignupPage />);
    expect(screen.getByText('Google で続ける')).toBeInTheDocument();
    expect(screen.getByText('GitHub で続ける')).toBeInTheDocument();
  });

  it('パスワード不一致のバリデーションエラーが表示されるべき', async () => {
    render(<SignupPage />);
    const inputs = screen.getAllByRole('textbox');
    const passwordInputs = document.querySelectorAll('input[type="password"]');
    fireEvent.change(inputs[0], { target: { value: '山田太郎' } });
    fireEvent.change(inputs[1], { target: { value: 'test@example.com' } });
    fireEvent.change(passwordInputs[0], { target: { value: 'password123' } });
    fireEvent.change(passwordInputs[1], { target: { value: 'different' } });
    const submitButton = screen.getByRole('button', {
      name: /メールアドレスで登録/,
    });
    fireEvent.click(submitButton);
    await waitFor(() => {
      expect(screen.getByText('パスワードが一致しません')).toBeInTheDocument();
    });
  });

  it('有効なフォーム送信でオンボーディングへ遷移するべき', async () => {
    render(<SignupPage />);
    const inputs = screen.getAllByRole('textbox');
    const passwordInputs = document.querySelectorAll('input[type="password"]');
    // 名前
    fireEvent.change(inputs[0], { target: { value: '山田太郎' } });
    // メールアドレス
    fireEvent.change(inputs[1], { target: { value: 'test@example.com' } });
    // パスワード
    fireEvent.change(passwordInputs[0], { target: { value: 'password123' } });
    // パスワード（確認）
    fireEvent.change(passwordInputs[1], { target: { value: 'password123' } });
    const submitButton = screen.getByRole('button', {
      name: /メールアドレスで登録/,
    });
    fireEvent.click(submitButton);
    await waitFor(
      () => {
        expect(mockPush).toHaveBeenCalledWith('/onboarding');
      },
      { timeout: 2000 }
    );
  });
});
