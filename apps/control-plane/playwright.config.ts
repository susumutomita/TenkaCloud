import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright E2E テスト設定
 *
 * AUTH_SKIP=1 モードでの認証フローをテストする
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? 'github' : 'html',
  use: {
    // basePath が /control に設定されているため、baseURL にも含める
    baseURL: 'http://localhost:13000/control',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    // AUTH_SKIP=1 をコマンドと env の両方で設定（確実に渡すため）
    command: 'AUTH_SKIP=1 bun run dev',
    // サーバーの起動確認は /control/login で行う（認証なしでアクセス可能）
    url: 'http://localhost:13000/control/login',
    reuseExistingServer: !process.env.CI,
    timeout: 300 * 1000,
    env: {
      AUTH_SKIP: '1',
      NODE_ENV: 'development',
    },
  },
});
