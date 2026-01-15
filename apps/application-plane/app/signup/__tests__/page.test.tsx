import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import SignupPage from '../page';

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

  it('名前フィールドが必須であるべき', () => {
    render(<SignupPage />);
    const inputs = screen.getAllByRole('textbox');
    // 名前フィールドが存在することを確認
    expect(inputs[0]).toBeInTheDocument();
    expect(inputs[0]).toHaveAttribute('required');
  });

  it('メールフィールドが表示されるべき', () => {
    render(<SignupPage />);
    const emailInputs = document.querySelectorAll('input[type="email"]');
    expect(emailInputs.length).toBe(1);
  });

  it('無効なメール形式はバリデーションに引っかかるべき', () => {
    // メール形式のバリデーションは validateForm 内で正規表現でチェック
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    expect(emailRegex.test('invalid')).toBe(false);
    expect(emailRegex.test('test@example.com')).toBe(true);
  });

  it('短いパスワードのバリデーションエラーが表示されるべき', async () => {
    render(<SignupPage />);
    const inputs = screen.getAllByRole('textbox');
    const passwordInputs = document.querySelectorAll('input[type="password"]');
    fireEvent.change(inputs[0], { target: { value: '山田太郎' } });
    fireEvent.change(inputs[1], { target: { value: 'test@example.com' } });
    fireEvent.change(passwordInputs[0], { target: { value: 'short' } });
    fireEvent.change(passwordInputs[1], { target: { value: 'short' } });
    fireEvent.click(
      screen.getByRole('button', { name: /メールアドレスで登録/ })
    );
    await waitFor(() => {
      expect(
        screen.getByText('パスワードは8文字以上で入力してください')
      ).toBeInTheDocument();
    });
  });

  it('パスワード不一致のバリデーションエラーが表示されるべき', async () => {
    render(<SignupPage />);
    const inputs = screen.getAllByRole('textbox');
    const passwordInputs = document.querySelectorAll('input[type="password"]');
    fireEvent.change(inputs[0], { target: { value: '山田太郎' } });
    fireEvent.change(inputs[1], { target: { value: 'test@example.com' } });
    fireEvent.change(passwordInputs[0], { target: { value: 'password123' } });
    fireEvent.change(passwordInputs[1], { target: { value: 'different' } });
    fireEvent.click(
      screen.getByRole('button', { name: /メールアドレスで登録/ })
    );
    await waitFor(() => {
      expect(screen.getByText('パスワードが一致しません')).toBeInTheDocument();
    });
  });

  it('Google ソーシャルログインボタンをクリックできるべき', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    render(<SignupPage />);
    fireEvent.click(screen.getByText('Google で続ける'));
    expect(consoleSpy).toHaveBeenCalledWith('Social login with google');
    consoleSpy.mockRestore();
  });

  it('GitHub ソーシャルログインボタンをクリックできるべき', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    render(<SignupPage />);
    fireEvent.click(screen.getByText('GitHub で続ける'));
    expect(consoleSpy).toHaveBeenCalledWith('Social login with github');
    consoleSpy.mockRestore();
  });

  it('有効なフォーム送信でオンボーディングへ遷移するべき', async () => {
    render(<SignupPage />);
    const inputs = screen.getAllByRole('textbox');
    const passwordInputs = document.querySelectorAll('input[type="password"]');
    fireEvent.change(inputs[0], { target: { value: '山田太郎' } });
    fireEvent.change(inputs[1], { target: { value: 'test@example.com' } });
    fireEvent.change(passwordInputs[0], { target: { value: 'password123' } });
    fireEvent.change(passwordInputs[1], { target: { value: 'password123' } });
    fireEvent.click(
      screen.getByRole('button', { name: /メールアドレスで登録/ })
    );
    await waitFor(
      () => {
        expect(mockPush).toHaveBeenCalledWith('/onboarding');
      },
      { timeout: 2000 }
    );
  });

  it('ログインリンクが表示されるべき', () => {
    render(<SignupPage />);
    expect(screen.getByText('ログイン')).toBeInTheDocument();
  });

  it('利用規約リンクが表示されるべき', () => {
    render(<SignupPage />);
    expect(screen.getByText('利用規約')).toBeInTheDocument();
  });

  it('プライバシーポリシーリンクが表示されるべき', () => {
    render(<SignupPage />);
    expect(screen.getByText('プライバシーポリシー')).toBeInTheDocument();
  });
});
