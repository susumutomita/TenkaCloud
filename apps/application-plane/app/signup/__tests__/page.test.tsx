import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import SignupPage from '../page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('../actions', () => ({
  signupWithAuth0: vi.fn(),
}));

describe('SignupPage', () => {
  it('ページタイトル「アカウント作成」が表示されるべき', () => {
    render(<SignupPage />);
    expect(screen.getByText('アカウント作成')).toBeInTheDocument();
  });

  it('キャッチフレーズが表示されるべき', () => {
    render(<SignupPage />);
    expect(
      screen.getByText('クラウド天下一武道会に参加しよう'),
    ).toBeInTheDocument();
  });

  it('メールアドレスで登録ボタンが表示されるべき', () => {
    render(<SignupPage />);
    expect(
      screen.getByRole('button', { name: /メールアドレスで登録/ }),
    ).toBeInTheDocument();
  });

  it('Google ソーシャルログインボタンが表示されるべき', () => {
    render(<SignupPage />);
    expect(
      screen.getByRole('button', { name: /Google で続ける/ }),
    ).toBeInTheDocument();
  });

  it('GitHub ソーシャルログインボタンが表示されるべき', () => {
    render(<SignupPage />);
    expect(
      screen.getByRole('button', { name: /GitHub で続ける/ }),
    ).toBeInTheDocument();
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

  it('TenkaCloud ロゴリンクが表示されるべき', () => {
    render(<SignupPage />);
    expect(screen.getByText('TenkaCloud')).toBeInTheDocument();
  });

  it('3つの送信フォームが存在すべき', () => {
    render(<SignupPage />);
    const forms = document.querySelectorAll('form');
    expect(forms.length).toBe(3);
  });
});
