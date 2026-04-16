import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import LoginPage from '../page';

// actions のモック
vi.mock('../actions', () => ({
  loginWithProvider: vi.fn(),
}));

// Cloudscape コンポーネントのモック
vi.mock('@cloudscape-design/components/box', () => ({
  default: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock('@cloudscape-design/components/container', () => ({
  default: ({
    children,
    header,
  }: {
    children?: React.ReactNode;
    header?: React.ReactNode;
  }) => (
    <div>
      {header}
      {children}
    </div>
  ),
}));

vi.mock('@cloudscape-design/components/header', () => ({
  default: ({
    children,
    description,
  }: {
    children?: React.ReactNode;
    description?: React.ReactNode;
  }) => (
    <div>
      <h1>{children}</h1>
      {description ? <p>{description}</p> : null}
    </div>
  ),
}));

vi.mock('@cloudscape-design/components/space-between', () => ({
  default: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock('@cloudscape-design/global-styles/index.css', () => ({}));

describe('LoginPage コンポーネント', () => {
  it('タイトルを表示すべき', () => {
    render(<LoginPage />);
    expect(screen.getByText('TenkaCloud Control Plane')).toBeInTheDocument();
  });

  it('サブタイトルを表示すべき', () => {
    render(<LoginPage />);
    expect(
      screen.getByText('プラットフォーム管理者向けコンソール'),
    ).toBeInTheDocument();
  });

  it('ログインボタンを表示すべき', () => {
    render(<LoginPage />);
    expect(
      screen.getByRole('button', { name: 'ログイン' }),
    ).toBeInTheDocument();
  });

  it('認証説明テキストを表示すべき', () => {
    render(<LoginPage />);
    expect(screen.getByText('AWS Cognito で認証します')).toBeInTheDocument();
  });

  it('form 要素が存在すべき', () => {
    const { container } = render(<LoginPage />);
    expect(container.querySelector('form')).toBeInTheDocument();
  });

  it('ログインボタンのタイプが submit であるべき', () => {
    render(<LoginPage />);
    const button = screen.getByRole('button', { name: 'ログイン' });
    expect(button).toHaveAttribute('type', 'submit');
  });
});
