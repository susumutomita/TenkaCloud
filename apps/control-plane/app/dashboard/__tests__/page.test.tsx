import { render, screen } from '@testing-library/react';
import { redirect } from 'next/navigation';
import type { Session } from 'next-auth';
import type { Mock } from 'vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getSession } from '@/auth';
import DashboardPage from '../page';

// API のモック（hoisted で先に定義）
const mockFetchDashboardStats = vi.hoisted(() => vi.fn());
const mockFetchActivities = vi.hoisted(() => vi.fn());

// getSession のモック
vi.mock('@/auth', () => ({
  getSession: vi.fn(),
}));

vi.mock('@/lib/api/stats-api', () => ({
  fetchDashboardStats: mockFetchDashboardStats,
}));

vi.mock('@/lib/api/activities-api', () => ({
  fetchActivities: mockFetchActivities,
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

// getSession を正しい型でモック
const mockedGetSession = getSession as unknown as Mock<
  () => Promise<Session | null>
>;

describe('DashboardPage コンポーネント', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('認証チェック', () => {
    it('未認証ユーザーは /login へリダイレクトされるべき', async () => {
      mockedGetSession.mockResolvedValue(null);

      await expect(DashboardPage()).rejects.toThrow('NEXT_REDIRECT: /login');
      expect(redirect).toHaveBeenCalledWith('/login');
    });

    it('session が存在するが user がない場合は /login へリダイレクトされるべき', async () => {
      mockedGetSession.mockResolvedValue({
        user: undefined as unknown as Session['user'],
        expires: '',
      });

      await expect(DashboardPage()).rejects.toThrow('NEXT_REDIRECT: /login');
      expect(redirect).toHaveBeenCalledWith('/login');
    });
  });

  describe('認証済みユーザー', () => {
    beforeEach(() => {
      mockedGetSession.mockResolvedValue({
        user: { name: 'Test User', email: 'test@example.com' },
        expires: '',
      });
      mockFetchDashboardStats.mockResolvedValue({
        activeTenants: 5,
        totalTenants: 10,
        systemStatus: 'healthy',
        uptimePercentage: 100,
      });
      mockFetchActivities.mockResolvedValue({
        data: [],
        pagination: { limit: 5, hasNextPage: false },
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
      mockedGetSession.mockResolvedValue({
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
      expect(screen.getByText('総テナント数')).toBeInTheDocument();
    });

    it('システムステータスが正常と表示されるべき', async () => {
      const Component = await DashboardPage();
      render(Component);
      expect(screen.getByText('正常')).toBeInTheDocument();
      expect(screen.getByText('100%')).toBeInTheDocument();
    });

    it('実際の統計値を表示すべき', async () => {
      const Component = await DashboardPage();
      render(Component);
      expect(screen.getByText('5')).toBeInTheDocument(); // activeTenants
      expect(screen.getByText('10')).toBeInTheDocument(); // totalTenants
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

    it('統計取得エラー時はハイフンを表示すべき', async () => {
      mockFetchDashboardStats.mockRejectedValue(new Error('Network error'));
      const Component = await DashboardPage();
      render(Component);
      // stats が null の場合、各項目はハイフン表示
      const dashElements = screen.getAllByText('-');
      expect(dashElements.length).toBeGreaterThan(0);
    });

    it('システムステータスが異常の場合は異常と表示すべき', async () => {
      mockFetchDashboardStats.mockResolvedValue({
        activeTenants: 3,
        totalTenants: 8,
        systemStatus: 'degraded',
        uptimePercentage: 95.5,
      });
      const Component = await DashboardPage();
      render(Component);
      expect(screen.getByText('異常')).toBeInTheDocument();
      expect(screen.getByText('95.5%')).toBeInTheDocument();
    });

    it('アクティビティを表示すべき', async () => {
      mockFetchActivities.mockResolvedValue({
        data: [
          {
            id: '01J123ABC',
            action: 'CREATE',
            resourceType: 'TENANT',
            resourceId: '01J456DEF',
            details: { name: 'Test Tenant' },
            timestamp: new Date().toISOString(),
          },
        ],
        pagination: { limit: 5, hasNextPage: false },
      });
      const Component = await DashboardPage();
      render(Component);
      expect(screen.getByText('テナントを作成しました')).toBeInTheDocument();
    });

    it('アクティビティ取得エラー時は空リストを表示すべき', async () => {
      mockFetchActivities.mockRejectedValue(new Error('Network error'));
      const Component = await DashboardPage();
      render(Component);
      expect(
        screen.getByText('アクティビティはありません')
      ).toBeInTheDocument();
    });

    it('複数のアクティビティを表示すべき', async () => {
      mockFetchActivities.mockResolvedValue({
        data: [
          {
            id: '01J123ABC',
            action: 'CREATE',
            resourceType: 'TENANT',
            timestamp: new Date().toISOString(),
          },
          {
            id: '01J456DEF',
            action: 'UPDATE',
            resourceType: 'SETTING',
            timestamp: new Date().toISOString(),
          },
        ],
        pagination: { limit: 5, hasNextPage: false },
      });
      const Component = await DashboardPage();
      render(Component);
      expect(screen.getByText('テナントを作成しました')).toBeInTheDocument();
      expect(screen.getByText('設定を更新しました')).toBeInTheDocument();
    });

    it('アクティビティの相対時間を「N分前」と表示すべき', async () => {
      const thirtyMinsAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      mockFetchActivities.mockResolvedValue({
        data: [
          {
            id: '01J123ABC',
            action: 'CREATE',
            resourceType: 'TENANT',
            timestamp: thirtyMinsAgo,
          },
        ],
        pagination: { limit: 5, hasNextPage: false },
      });
      const Component = await DashboardPage();
      render(Component);
      expect(screen.getByText('30分前')).toBeInTheDocument();
    });

    it('アクティビティの相対時間を「N時間前」と表示すべき', async () => {
      const fiveHoursAgo = new Date(
        Date.now() - 5 * 60 * 60 * 1000
      ).toISOString();
      mockFetchActivities.mockResolvedValue({
        data: [
          {
            id: '01J123ABC',
            action: 'UPDATE',
            resourceType: 'USER',
            timestamp: fiveHoursAgo,
          },
        ],
        pagination: { limit: 5, hasNextPage: false },
      });
      const Component = await DashboardPage();
      render(Component);
      expect(screen.getByText('5時間前')).toBeInTheDocument();
    });

    it('アクティビティの相対時間を「N日前」と表示すべき', async () => {
      const threeDaysAgo = new Date(
        Date.now() - 3 * 24 * 60 * 60 * 1000
      ).toISOString();
      mockFetchActivities.mockResolvedValue({
        data: [
          {
            id: '01J123ABC',
            action: 'DELETE',
            resourceType: 'BATTLE',
            timestamp: threeDaysAgo,
          },
        ],
        pagination: { limit: 5, hasNextPage: false },
      });
      const Component = await DashboardPage();
      render(Component);
      expect(screen.getByText('3日前')).toBeInTheDocument();
    });

    it('7日以上前のアクティビティは日付形式で表示すべき', async () => {
      const tenDaysAgo = new Date(
        Date.now() - 10 * 24 * 60 * 60 * 1000
      ).toISOString();
      mockFetchActivities.mockResolvedValue({
        data: [
          {
            id: '01J123ABC',
            action: 'ACCESS',
            resourceType: 'PROBLEM',
            timestamp: tenDaysAgo,
          },
        ],
        pagination: { limit: 5, hasNextPage: false },
      });
      const Component = await DashboardPage();
      render(Component);
      // 日本語の日付形式（例: 2024/12/15）が表示される
      const expectedDate = new Date(tenDaysAgo).toLocaleDateString('ja-JP');
      expect(screen.getByText(expectedDate)).toBeInTheDocument();
    });

    it('未知のアクション/リソースタイプはそのまま表示すべき', async () => {
      mockFetchActivities.mockResolvedValue({
        data: [
          {
            id: '01J123ABC',
            action: 'UNKNOWN_ACTION' as unknown as 'CREATE',
            resourceType: 'UNKNOWN_RESOURCE' as unknown as 'TENANT',
            timestamp: new Date().toISOString(),
          },
        ],
        pagination: { limit: 5, hasNextPage: false },
      });
      const Component = await DashboardPage();
      render(Component);
      // フォールバック: 元の値がそのまま使用される
      expect(
        screen.getByText('UNKNOWN_RESOURCEをUNKNOWN_ACTIONしました')
      ).toBeInTheDocument();
    });
  });
});
