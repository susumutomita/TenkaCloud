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

  test('ルートパスにアクセスするとダッシュボードにリダイレクトされるべき', async ({
    page,
  }) => {
    await page.goto('/');
    // AUTH_SKIP=1 モードでは認証済みとして扱われるので、ダッシュボードにリダイレクトされる
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test('API 認証ルートにはアクセスできるべき', async ({ page }) => {
    // NextAuth の認証エンドポイントはアクセス可能
    // Auth0 が設定されていない CI 環境では 500 を返す可能性がある
    const response = await page.request.get('/api/auth/providers');
    // エンドポイントが存在することを確認（404 でないこと）
    expect(response.status()).not.toBe(404);
  });
});
