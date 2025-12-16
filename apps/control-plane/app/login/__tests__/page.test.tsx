import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import LoginPage from '../page';

// actions のモック
vi.mock('../actions', () => ({
  loginWithAuth0: vi.fn(),
}));

describe('LoginPage コンポーネント', () => {
  it('タイトルを表示すべき', () => {
    render(<LoginPage />);
    expect(screen.getByText('TenkaCloud Control Plane')).toBeInTheDocument();
  });

  it('サブタイトルを表示すべき', () => {
    render(<LoginPage />);
    expect(
      screen.getByText('プラットフォーム管理者向けコンソール')
    ).toBeInTheDocument();
  });

  it('ログインボタンを表示すべき', () => {
    render(<LoginPage />);
    expect(
      screen.getByRole('button', { name: 'Auth0 でログイン' })
    ).toBeInTheDocument();
  });

  it('認証説明テキストを表示すべき', () => {
    render(<LoginPage />);
    expect(screen.getByText('認証には Auth0 を使用します')).toBeInTheDocument();
  });

  it('form 要素が存在すべき', () => {
    const { container } = render(<LoginPage />);
    expect(container.querySelector('form')).toBeInTheDocument();
  });

  it('ログインボタンのタイプが submit であるべき', () => {
    render(<LoginPage />);
    const button = screen.getByRole('button', { name: 'Auth0 でログイン' });
    expect(button).toHaveAttribute('type', 'submit');
  });
});
