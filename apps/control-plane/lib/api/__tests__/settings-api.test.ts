import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@/types/settings';

describe('Settings API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  describe('サーバーサイド（window がない場合）', () => {
    describe('fetchSettings', () => {
      it('設定を取得できるべき', async () => {
        vi.stubGlobal('window', undefined);

        const { fetchSettings } = await import('../settings-api');

        const mockSettings = {
          platform: {
            platformName: 'Test Platform',
            language: 'en',
            timezone: 'UTC',
          },
          security: {
            mfaRequired: true,
            sessionTimeoutMinutes: 30,
            maxLoginAttempts: 3,
          },
          notifications: {
            emailNotificationsEnabled: false,
            systemAlertsEnabled: true,
            maintenanceNotificationsEnabled: false,
          },
          appearance: {
            theme: 'dark',
          },
        };

        global.fetch = vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(mockSettings),
        });

        const result = await fetchSettings();

        expect(result).toEqual(mockSettings);
        expect(global.fetch).toHaveBeenCalledWith(
          expect.stringContaining('/settings'),
          { cache: 'no-store' }
        );

        vi.unstubAllGlobals();
      });

      it('APIエラー時に例外をスローすべき', async () => {
        vi.stubGlobal('window', undefined);

        const { fetchSettings } = await import('../settings-api');

        global.fetch = vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
        });

        await expect(fetchSettings()).rejects.toThrow(
          'Failed to fetch settings: 500'
        );

        vi.unstubAllGlobals();
      });

      it('環境変数が設定されている場合はそれを使用すべき', async () => {
        vi.stubGlobal('window', undefined);
        vi.stubEnv('TENANT_API_BASE_URL', 'http://custom-api:8080/api');

        const { fetchSettings } = await import('../settings-api');

        global.fetch = vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(DEFAULT_SETTINGS),
        });

        await fetchSettings();

        expect(global.fetch).toHaveBeenCalledWith(
          'http://custom-api:8080/api/settings',
          { cache: 'no-store' }
        );

        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
      });
    });

    describe('getSettings', () => {
      it('設定を取得できるべき', async () => {
        vi.stubGlobal('window', undefined);

        const { getSettings } = await import('../settings-api');

        const mockSettings = {
          platform: {
            platformName: 'Test Platform',
            language: 'en',
            timezone: 'UTC',
          },
          security: {
            mfaRequired: true,
            sessionTimeoutMinutes: 30,
            maxLoginAttempts: 3,
          },
          notifications: {
            emailNotificationsEnabled: false,
            systemAlertsEnabled: true,
            maintenanceNotificationsEnabled: false,
          },
          appearance: {
            theme: 'dark',
          },
        };

        global.fetch = vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(mockSettings),
        });

        const result = await getSettings();
        expect(result).toEqual(mockSettings);

        vi.unstubAllGlobals();
      });

      it('エラー時にデフォルト設定を返すべき', async () => {
        vi.stubGlobal('window', undefined);

        const { getSettings } = await import('../settings-api');

        global.fetch = vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
        });

        const result = await getSettings();
        expect(result).toEqual(DEFAULT_SETTINGS);

        vi.unstubAllGlobals();
      });
    });

    describe('saveSettings', () => {
      it('設定を保存できるべき', async () => {
        vi.stubGlobal('window', undefined);

        const { saveSettings } = await import('../settings-api');

        const settings = {
          platform: {
            platformName: 'New Platform',
            language: 'ja' as const,
            timezone: 'Asia/Tokyo',
          },
          security: {
            mfaRequired: false,
            sessionTimeoutMinutes: 60,
            maxLoginAttempts: 5,
          },
          notifications: {
            emailNotificationsEnabled: true,
            systemAlertsEnabled: true,
            maintenanceNotificationsEnabled: true,
          },
          appearance: {
            theme: 'system' as const,
          },
        };

        global.fetch = vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ success: true }),
        });

        await saveSettings(settings);

        expect(global.fetch).toHaveBeenCalledWith(
          expect.stringContaining('/settings'),
          {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(settings),
          }
        );

        vi.unstubAllGlobals();
      });

      it('保存失敗時に例外をスローすべき', async () => {
        vi.stubGlobal('window', undefined);

        const { saveSettings } = await import('../settings-api');

        global.fetch = vi.fn().mockResolvedValue({
          ok: false,
          status: 400,
        });

        await expect(saveSettings(DEFAULT_SETTINGS)).rejects.toThrow(
          'Failed to save settings: 400'
        );

        vi.unstubAllGlobals();
      });
    });
  });

  describe('クライアントサイド（window がある場合）', () => {
    it('クライアント環境変数を使用すべき', async () => {
      vi.stubGlobal('window', {});
      vi.stubEnv(
        'NEXT_PUBLIC_TENANT_API_BASE_URL',
        'http://client-api:9000/api'
      );

      const { fetchSettings } = await import('../settings-api');

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(DEFAULT_SETTINGS),
      });

      await fetchSettings();

      expect(global.fetch).toHaveBeenCalledWith(
        'http://client-api:9000/api/settings',
        { cache: 'no-store' }
      );

      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    });

    it('クライアント環境変数が未設定の場合はデフォルトを使用すべき', async () => {
      vi.stubGlobal('window', {});

      const { fetchSettings } = await import('../settings-api');

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(DEFAULT_SETTINGS),
      });

      await fetchSettings();

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3004/api/settings',
        { cache: 'no-store' }
      );

      vi.unstubAllGlobals();
    });
  });
});
