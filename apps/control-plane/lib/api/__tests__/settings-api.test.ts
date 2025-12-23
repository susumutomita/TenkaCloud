import { describe, expect, it, vi } from 'vitest';
import type { Settings } from '@/types/settings';
import { saveSettings } from '../settings-api';

describe('saveSettings', () => {
  it('設定を保存できるべき', async () => {
    vi.useFakeTimers();
    const mockSettings: Settings = {
      platform: {
        platformName: 'Test Platform',
        language: 'ja',
        timezone: 'Asia/Tokyo',
      },
      appearance: {
        theme: 'light',
      },
      notifications: {
        emailNotificationsEnabled: true,
        systemAlertsEnabled: true,
        maintenanceNotificationsEnabled: true,
      },
      security: {
        mfaRequired: false,
        sessionTimeoutMinutes: 30,
        maxLoginAttempts: 5,
      },
    };

    const savePromise = saveSettings(mockSettings);
    vi.advanceTimersByTime(500);
    await expect(savePromise).resolves.toBeUndefined();

    vi.useRealTimers();
  });
});
