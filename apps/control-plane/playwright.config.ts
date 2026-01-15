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
    baseURL: 'http://localhost:13000',
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
    command: process.env.CI
      ? 'AUTH_SKIP=1 bun run start'
      : 'AUTH_SKIP=1 bun run dev',
    url: 'http://localhost:13000',
    reuseExistingServer: !process.env.CI,
    timeout: 180 * 1000,
    env: {
      AUTH_SKIP: '1',
    },
  },
});
