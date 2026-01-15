import { test, expect } from '@playwright/test';

/**
 * ダッシュボード E2E テスト
 *
 * AUTH_SKIP=1 モードでのダッシュボードアクセスを検証する
 * basePath: /control が設定されているため、URL は /control/... になる
 */
const BASE_PATH = '/control';

test.describe('ダッシュボード', () => {
  test('ダッシュボードページにアクセスできるべき', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page).toHaveURL(new RegExp(`${BASE_PATH}/dashboard$`));

    // ダッシュボードタイトルが表示されることを確認
    await expect(
      page.getByRole('heading', { name: 'ダッシュボード' })
    ).toBeVisible();
  });

  test('ウェルカムメッセージが表示されるべき', async ({ page }) => {
    await page.goto('/dashboard');

    // AUTH_SKIP モードではモックユーザーの名前が表示される
    await expect(page.getByText(/ようこそ/)).toBeVisible();
  });

  test('クイックアクションが表示されるべき', async ({ page }) => {
    await page.goto('/dashboard');

    // クイックアクションセクションが表示されることを確認
    await expect(page.getByText('クイックアクション')).toBeVisible();
    // メインコンテンツ内のクイックアクションリンクを確認（サイドバーと区別）
    await expect(
      page.getByRole('main').getByRole('link', { name: 'テナント管理' })
    ).toBeVisible();
    await expect(
      page.getByRole('main').getByRole('link', { name: '新規テナント作成' })
    ).toBeVisible();
  });

  test('テナント管理リンクをクリックするとテナント一覧ページに遷移するべき', async ({
    page,
  }) => {
    await page.goto('/dashboard');

    // メインコンテンツ内のクイックアクションリンクをクリック
    await page
      .getByRole('main')
      .getByRole('link', { name: 'テナント管理' })
      .click();
    await expect(page).toHaveURL(new RegExp(`${BASE_PATH}/dashboard/tenants$`));
  });

  test('新規テナント作成リンクをクリックするとテナント作成ページに遷移するべき', async ({
    page,
  }) => {
    await page.goto('/dashboard');

    // メインコンテンツ内のクイックアクションリンクをクリック
    await page
      .getByRole('main')
      .getByRole('link', { name: '新規テナント作成' })
      .click();
    await expect(page).toHaveURL(
      new RegExp(`${BASE_PATH}/dashboard/tenants/new$`)
    );
  });
});

test.describe('テナント管理ページ', () => {
  test('テナント一覧ページにアクセスできるべき', async ({ page }) => {
    await page.goto('/dashboard/tenants');
    await expect(page).toHaveURL(new RegExp(`${BASE_PATH}/dashboard/tenants$`));
  });

  test('新規テナント作成ページにアクセスできるべき', async ({ page }) => {
    await page.goto('/dashboard/tenants/new');
    await expect(page).toHaveURL(
      new RegExp(`${BASE_PATH}/dashboard/tenants/new$`)
    );
  });
});

test.describe('設定ページ', () => {
  test('設定ページにアクセスできるべき', async ({ page }) => {
    await page.goto('/dashboard/settings');
    await expect(page).toHaveURL(
      new RegExp(`${BASE_PATH}/dashboard/settings$`)
    );
  });
});
