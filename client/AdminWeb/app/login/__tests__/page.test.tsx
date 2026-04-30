import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRouter } from 'next/navigation';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuth } from '@/lib/auth/auth-context';
import LoginPage from '../page';

const signInMock = vi.fn();
const replaceMock = vi.fn();

vi.mock('@/lib/auth/auth-context', () => ({
  useAuth: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(),
}));

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
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useRouter).mockReturnValue({
      replace: replaceMock,
    } as unknown as ReturnType<typeof useRouter>);
    vi.mocked(useAuth).mockReturnValue({
      session: null,
      signIn: signInMock,
      signOut: vi.fn(),
      setTokens: vi.fn(),
    });
  });

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

  it('ログインボタンクリックで signIn が呼ばれるべき', async () => {
    const user = userEvent.setup();
    render(<LoginPage />);

    await user.click(screen.getByRole('button', { name: 'ログイン' }));

    expect(signInMock).toHaveBeenCalled();
  });

  it('既にログイン済みなら /dashboard へ replace すべき', () => {
    vi.mocked(useAuth).mockReturnValue({
      session: {
        user: { email: 'a@e.com', roles: [] },
        idToken: 'i',
        accessToken: 'a',
        expires: new Date(Date.now() + 60_000).toISOString(),
      },
      signIn: signInMock,
      signOut: vi.fn(),
      setTokens: vi.fn(),
    });
    render(<LoginPage />);
    expect(replaceMock).toHaveBeenCalledWith('/dashboard');
  });
});
