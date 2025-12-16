import { render, screen } from '@testing-library/react';
import { redirect } from 'next/navigation';
import type { Session } from 'next-auth';
import type { Mock } from 'vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { auth } from '@/auth';
import DashboardPage from '../page';

// auth のモック
vi.mock('@/auth', () => ({
  auth: vi.fn(),
}));

// next/navigation のモック
// redirect() は実際には例外をスローして実行を停止する
class RedirectError extends Error {
  constructor(public url: string) {
    super(`NEXT_REDIRECT: ${url}`);
  }
}

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new RedirectError(url);
  }),
}));

// auth を正しい型でモック
const mockedAuth = auth as unknown as Mock<() => Promise<Session | null>>;

describe('DashboardPage コンポーネント', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('認証チェック', () => {
    it('未認証ユーザーは /login へリダイレクトされるべき', async () => {
      mockedAuth.mockResolvedValue(null);

      await expect(DashboardPage()).rejects.toThrow('NEXT_REDIRECT: /login');
      expect(redirect).toHaveBeenCalledWith('/login');
    });

    it('session が存在するが user がない場合は /login へリダイレクトされるべき', async () => {
      mockedAuth.mockResolvedValue({
        user: undefined as unknown as Session['user'],
        expires: '',
      });

      await expect(DashboardPage()).rejects.toThrow('NEXT_REDIRECT: /login');
      expect(redirect).toHaveBeenCalledWith('/login');
    });
  });

  describe('認証済みユーザー', () => {
    beforeEach(() => {
      mockedAuth.mockResolvedValue({
        user: { name: 'Test User', email: 'test@example.com' },
        expires: '',
      });
    });

    it('ダッシュボードタイトルを表示すべき', async () => {
      const Component = await DashboardPage();
      render(Component);
      expect(screen.getByText('ダッシュボード')).toBeInTheDocument();
    });

    it('ユーザー名で挨拶すべき', async () => {
      const Component = await DashboardPage();
      render(Component);
      expect(screen.getByText(/ようこそ、Test User さん/)).toBeInTheDocument();
    });

    it('ユーザー名がない場合はメールで挨拶すべき', async () => {
      mockedAuth.mockResolvedValue({
        user: {
          name: undefined as unknown as string,
          email: 'test@example.com',
        },
        expires: '',
      });
      const Component = await DashboardPage();
      render(Component);
      expect(
        screen.getByText(/ようこそ、test@example.com さん/)
      ).toBeInTheDocument();
    });

    it('統計カードを表示すべき', async () => {
      const Component = await DashboardPage();
      render(Component);
      expect(screen.getByText('アクティブテナント')).toBeInTheDocument();
      expect(screen.getByText('システムステータス')).toBeInTheDocument();
      expect(screen.getByText('総ユーザー数')).toBeInTheDocument();
    });

    it('システムステータスが正常と表示されるべき', async () => {
      const Component = await DashboardPage();
      render(Component);
      expect(screen.getByText('正常')).toBeInTheDocument();
      expect(screen.getByText('100%')).toBeInTheDocument();
    });

    it('クイックアクションセクションを表示すべき', async () => {
      const Component = await DashboardPage();
      render(Component);
      expect(screen.getByText('クイックアクション')).toBeInTheDocument();
      expect(screen.getByText('よく使う操作')).toBeInTheDocument();
    });

    it('テナント管理リンクを表示すべき', async () => {
      const Component = await DashboardPage();
      render(Component);
      expect(
        screen.getByRole('link', { name: 'テナント管理' })
      ).toHaveAttribute('href', '/dashboard/tenants');
    });

    it('新規テナント作成リンクを表示すべき', async () => {
      const Component = await DashboardPage();
      render(Component);
      expect(
        screen.getByRole('link', { name: '新規テナント作成' })
      ).toHaveAttribute('href', '/dashboard/tenants/new');
    });

    it('最近のアクティビティセクションを表示すべき', async () => {
      const Component = await DashboardPage();
      render(Component);
      expect(screen.getByText('最近のアクティビティ')).toBeInTheDocument();
      expect(screen.getByText('直近のシステムイベント')).toBeInTheDocument();
      expect(
        screen.getByText('アクティビティはありません')
      ).toBeInTheDocument();
    });
  });
});
