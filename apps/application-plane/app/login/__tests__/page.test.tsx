import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import LoginPage from '../page';

vi.mock('../actions', () => ({
  loginWithAuth0: vi.fn(),
}));

describe('Application Plane ログインページ', () => {
  it('ページタイトル「TenkaCloud」が表示されるべき', () => {
    render(<LoginPage />);
    const title = screen.getByText('TenkaCloud');
    expect(title).toBeInTheDocument();
  });

  it('サブタイトル「クラウド天下一武道会 — 競技者ポータル」が表示されるべき', () => {
    render(<LoginPage />);
    const subtitle = screen.getByText('クラウド天下一武道会 — 競技者ポータル');
    expect(subtitle).toBeInTheDocument();
  });

  it('「Auth0 でログイン」ボタンが表示されるべき', () => {
    render(<LoginPage />);
    const loginButton = screen.getByRole('button', {
      name: 'Auth0 でログイン',
    });
    expect(loginButton).toBeInTheDocument();
  });

  it('AWS Console アクセスの説明が表示されるべき', () => {
    render(<LoginPage />);
    const description = screen.getByText(
      'ログイン後、バトルに参加して AWS Console にアクセスできます'
    );
    expect(description).toBeInTheDocument();
  });

  it('フォームが loginWithAuth0 アクションに関連付けられるべき', () => {
    render(<LoginPage />);
    const form = document.querySelector('form');
    expect(form).toBeInTheDocument();
  });
});
