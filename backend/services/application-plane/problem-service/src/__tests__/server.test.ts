/**
 * Server Entry Point Tests
 *
 * サーバーエントリポイントのテスト
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Bun serve をモック
const mockServe = vi.fn();
vi.mock('bun', () => ({
  serve: mockServe,
}));

// routes をモック
vi.mock('../routes', () => ({
  app: {
    fetch: vi.fn(),
  },
}));

describe('Server', () => {
  const originalEnv = process.env;
  const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

  beforeEach(() => {
    vi.clearAllMocks();
    // 環境変数をリセット
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.resetModules();
  });

  it('デフォルトポート 3100 でサーバーを起動するべき', async () => {
    delete process.env.PORT;

    // server モジュールを動的にインポート
    await import('../server');

    expect(mockServe).toHaveBeenCalledWith(
      expect.objectContaining({
        port: 3100,
      })
    );
  });

  it('環境変数 PORT でカスタムポートを使用するべき', async () => {
    process.env.PORT = '4000';

    // モジュールキャッシュをクリアして再インポート
    vi.resetModules();
    await import('../server');

    expect(mockServe).toHaveBeenCalledWith(
      expect.objectContaining({
        port: 4000,
      })
    );
  });

  it('app.fetch を serve に渡すべき', async () => {
    const { app } = await import('../routes');

    vi.resetModules();
    await import('../server');

    expect(mockServe).toHaveBeenCalledWith(
      expect.objectContaining({
        fetch: app.fetch,
      })
    );
  });

  it('起動メッセージをコンソールに出力するべき', async () => {
    vi.resetModules();
    await import('../server');

    expect(consoleSpy).toHaveBeenCalled();
    const logCalls = consoleSpy.mock.calls;
    const allLogs = logCalls.map((call) => call[0]).join('\n');
    expect(allLogs).toContain('TenkaCloud Problem Management Service');
    expect(allLogs).toContain('Server');
  });
});
