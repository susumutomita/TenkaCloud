export type Theme = 'light' | 'dark' | 'system';
export type Language = 'ja' | 'en';

export interface PlatformSettings {
  platformName: string;
  language: Language;
  timezone: string;
}

export interface SecuritySettings {
  mfaRequired: boolean;
  sessionTimeoutMinutes: number;
  maxLoginAttempts: number;
}

export interface NotificationSettings {
  emailNotificationsEnabled: boolean;
  systemAlertsEnabled: boolean;
  maintenanceNotificationsEnabled: boolean;
}

export interface AppearanceSettings {
  theme: Theme;
}

export interface Settings {
  platform: PlatformSettings;
  security: SecuritySettings;
  notifications: NotificationSettings;
  appearance: AppearanceSettings;
}

export const DEFAULT_SETTINGS: Settings = {
  platform: {
    platformName: 'TenkaCloud',
    language: 'ja',
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
    theme: 'system',
  },
};

export const LANGUAGES: { value: Language; label: string }[] = [
  { value: 'ja', label: '日本語' },
  { value: 'en', label: 'English' },
];

export const THEMES: { value: Theme; label: string }[] = [
  { value: 'light', label: 'ライト' },
  { value: 'dark', label: 'ダーク' },
  { value: 'system', label: 'システム設定に従う' },
];

export const TIMEZONES = [
  'Asia/Tokyo',
  'Asia/Seoul',
  'Asia/Shanghai',
  'Asia/Singapore',
  'America/New_York',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Paris',
  'UTC',
];
