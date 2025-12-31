import { test, expect } from '@playwright/test';

/**
 * 認証フローの E2E テスト
 *
 * AUTH_SKIP=1 モードでの認証フローを検証する
 * このモードでは全ユーザーが認証済みとして扱われる
 */
test.describe('認証フロー（AUTH_SKIP モード）', () => {
  test('ログインページにアクセスするとダッシュボードにリダイレクトされるべき', async ({
    page,
  }) => {
    // AUTH_SKIP=1 モードでは認証済みユーザーはダッシュボードにリダイレクトされる
    await page.goto('/login');
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test('ルートパスにアクセスすると適切にリダイレクトされるべき', async ({
    page,
  }) => {
    await page.goto('/');
    // AUTH_SKIP=1 モードでは認証済みとして扱われるので、ダッシュボードまたはホーム画面が表示される
    // ミドルウェアが NextResponse.next() を返すので、ルートページがそのまま表示される
    await expect(page).toHaveURL('/');
  });

  test('API 認証ルートにはアクセスできるべき', async ({ page }) => {
    // NextAuth の認証エンドポイントは常にアクセス可能
    const response = await page.request.get('/api/auth/providers');
    expect(response.status()).toBe(200);
  });
});
