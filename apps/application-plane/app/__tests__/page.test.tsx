import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Home from '../page';

const mocks = vi.hoisted(() => ({
  useSession: vi.fn(),
  signOut: vi.fn(),
  push: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push }),
  usePathname: () => '/',
  useSearchParams: () => null,
}));

vi.mock('next-auth/react', () => ({
  useSession: () => mocks.useSession(),
  signOut: mocks.signOut,
}));

vi.mock('@/lib/tenant', () => ({
  useTenantOptional: () => null,
}));

async function renderAndWaitForMount() {
  render(<Home />);
  await waitFor(() => {
    expect(screen.getByText('クラウドスキルを競い')).toBeInTheDocument();
  });
}

describe('Participant App ホームページ', () => {
  beforeEach(() => {
    mocks.useSession.mockReturnValue({
      data: null,
      status: 'unauthenticated',
    });
  });

  it('ヒーローセクションのキャッチコピーが表示されるべき', async () => {
    await renderAndWaitForMount();
    expect(screen.getByText('クラウドスキルを競い')).toBeInTheDocument();
    expect(screen.getByText('高め合う場所')).toBeInTheDocument();
  });

  it('「イベントを探す」リンクが /events へのリンクを持つべき', async () => {
    await renderAndWaitForMount();
    const link = screen.getByRole('link', { name: /イベントを探す/ });
    expect(link).toHaveAttribute('href', '/events');
  });

  it('「ランキングを見る」リンクが /rankings へのリンクを持つべき', async () => {
    await renderAndWaitForMount();
    const links = screen.getAllByRole('link', { name: /ランキングを見る/ });
    expect(links[0]).toHaveAttribute('href', '/rankings');
  });

  describe('特徴セクション', () => {
    it('「TenkaCloud とは」セクションが表示されるべき', async () => {
      await renderAndWaitForMount();
      expect(screen.getByText('TenkaCloud とは')).toBeInTheDocument();
    });

    it.each([
      'マルチクラウド対応',
      '実践的な課題',
      'チーム or 個人',
      'リアルタイム採点',
    ])('特徴「%s」が表示されるべき', async (feature) => {
      await renderAndWaitForMount();
      expect(screen.getByText(feature)).toBeInTheDocument();
    });
  });

  describe('イベントタイプセクション', () => {
    it('「イベントタイプ」セクションが表示されるべき', async () => {
      await renderAndWaitForMount();
      expect(screen.getByText('イベントタイプ')).toBeInTheDocument();
    });

    it.each(['Incident Drill', 'Challenge'])(
      'イベントタイプ「%s」が表示されるべき',
      async (eventType) => {
        await renderAndWaitForMount();
        expect(screen.getByText(eventType)).toBeInTheDocument();
      },
    );
  });

  it('観戦 CTA セクションが表示されるべき', async () => {
    await renderAndWaitForMount();
    expect(screen.getByText('まずは観戦してみよう')).toBeInTheDocument();
  });

  it('フッターが表示されるべき', async () => {
    await renderAndWaitForMount();
    expect(
      screen.getByText('TenkaCloud - The Open Cloud Battle Arena'),
    ).toBeInTheDocument();
  });

  describe('ナビゲーション', () => {
    it('未認証の場合はログインリンクが表示されるべき', async () => {
      await renderAndWaitForMount();
      const loginLinks = screen.getAllByText('ログイン');
      expect(loginLinks.length).toBeGreaterThan(0);
    });

    describe('ログイン済みの場合', () => {
      beforeEach(() => {
        mocks.useSession.mockReturnValue({
          data: {
            user: { name: 'テストユーザー' },
          },
          status: 'authenticated',
        });
      });

      it('ユーザー名がナビゲーションに表示されるべき', async () => {
        await renderAndWaitForMount();
        expect(screen.getAllByText('テストユーザー').length).toBeGreaterThan(0);
      });
    });

    describe('ログイン済みでユーザー名がない場合', () => {
      beforeEach(() => {
        mocks.useSession.mockReturnValue({
          data: {
            user: {},
          },
          status: 'authenticated',
        });
      });

      it('デフォルトの「ユーザー」がナビゲーションに表示されるべき', async () => {
        await renderAndWaitForMount();
        expect(screen.getAllByText('ユーザー').length).toBeGreaterThan(0);
      });
    });
  });
});
