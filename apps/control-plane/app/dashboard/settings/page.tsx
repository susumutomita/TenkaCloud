'use client';

import { useState } from 'react';
import { saveSettings } from '@/lib/api/settings-api';
import {
  DEFAULT_SETTINGS,
  LANGUAGES,
  type Settings,
  THEMES,
  TIMEZONES,
} from '@/types/settings';

interface SettingsPageProps {
  initialSettings?: Settings;
}

export default function SettingsPage({
  initialSettings = DEFAULT_SETTINGS,
}: SettingsPageProps) {
  const [settings, setSettings] = useState<Settings>(initialSettings);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  const handleSave = async () => {
    setIsSaving(true);
    setMessage(null);

    try {
      await saveSettings(settings);
      setMessage({ type: 'success', text: '設定を保存しました' });
    } catch (error) {
      console.error('Failed to save settings:', error);
      setMessage({ type: 'error', text: '設定の保存に失敗しました' });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">設定</h1>
        <p className="mt-2 text-sm text-muted-foreground text-gray-500">
          プラットフォームの設定を管理します
        </p>
      </div>

      {message && (
        <div
          className={`rounded-md p-4 ${
            message.type === 'success'
              ? 'bg-green-50 border border-green-200'
              : 'bg-red-50 border border-red-200'
          }`}
        >
          <p
            className={`text-sm ${
              message.type === 'success' ? 'text-green-800' : 'text-red-800'
            }`}
          >
            {message.text}
          </p>
        </div>
      )}

      <div className="space-y-6">
        {/* プラットフォーム設定 */}
        <section className="rounded-xl border bg-card text-card-foreground shadow">
          <div className="flex flex-col space-y-1.5 p-6 border-b">
            <h2 className="text-lg font-semibold leading-none tracking-tight">
              プラットフォーム設定
            </h2>
            <p className="text-sm text-muted-foreground text-gray-500">
              基本的なプラットフォームの設定を行います
            </p>
          </div>
          <div className="p-6 space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <label
                  htmlFor="platformName"
                  className="text-sm font-medium leading-none"
                >
                  プラットフォーム名
                </label>
                <input
                  id="platformName"
                  className="flex h-10 w-full rounded-md border border-gray-300 bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  value={settings.platform.platformName}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      platform: {
                        ...settings.platform,
                        platformName: e.target.value,
                      },
                    })
                  }
                />
              </div>
              <div className="space-y-2">
                <label
                  htmlFor="language"
                  className="text-sm font-medium leading-none"
                >
                  言語
                </label>
                <select
                  id="language"
                  className="flex h-10 w-full rounded-md border border-gray-300 bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  value={settings.platform.language}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      platform: {
                        ...settings.platform,
                        language: e.target.value as 'ja' | 'en',
                      },
                    })
                  }
                >
                  {LANGUAGES.map((lang) => (
                    <option key={lang.value} value={lang.value}>
                      {lang.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <label
                  htmlFor="timezone"
                  className="text-sm font-medium leading-none"
                >
                  タイムゾーン
                </label>
                <select
                  id="timezone"
                  className="flex h-10 w-full rounded-md border border-gray-300 bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  value={settings.platform.timezone}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      platform: {
                        ...settings.platform,
                        timezone: e.target.value,
                      },
                    })
                  }
                >
                  {TIMEZONES.map((tz) => (
                    <option key={tz} value={tz}>
                      {tz}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>
        </section>

        {/* 外観設定 */}
        <section className="rounded-xl border bg-card text-card-foreground shadow">
          <div className="flex flex-col space-y-1.5 p-6 border-b">
            <h2 className="text-lg font-semibold leading-none tracking-tight">
              外観設定
            </h2>
            <p className="text-sm text-muted-foreground text-gray-500">
              アプリケーションの表示設定を行います
            </p>
          </div>
          <div className="p-6 space-y-4">
            <div className="space-y-2">
              <label
                htmlFor="theme"
                className="text-sm font-medium leading-none"
              >
                テーマ
              </label>
              <select
                id="theme"
                className="flex h-10 w-full max-w-xs rounded-md border border-gray-300 bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={settings.appearance.theme}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    appearance: {
                      ...settings.appearance,
                      theme: e.target.value as 'light' | 'dark' | 'system',
                    },
                  })
                }
              >
                {THEMES.map((theme) => (
                  <option key={theme.value} value={theme.value}>
                    {theme.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </section>

        {/* 通知設定 */}
        <section className="rounded-xl border bg-card text-card-foreground shadow">
          <div className="flex flex-col space-y-1.5 p-6 border-b">
            <h2 className="text-lg font-semibold leading-none tracking-tight">
              通知設定
            </h2>
            <p className="text-sm text-muted-foreground text-gray-500">
              通知の受信設定を行います
            </p>
          </div>
          <div className="p-6 space-y-4">
            <div className="space-y-4">
              <label className="flex items-center space-x-3 cursor-pointer">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
                  checked={settings.notifications.emailNotificationsEnabled}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      notifications: {
                        ...settings.notifications,
                        emailNotificationsEnabled: e.target.checked,
                      },
                    })
                  }
                />
                <div>
                  <span className="text-sm font-medium">メール通知</span>
                  <p className="text-xs text-gray-500">
                    重要なイベントをメールで通知します
                  </p>
                </div>
              </label>
              <label className="flex items-center space-x-3 cursor-pointer">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
                  checked={settings.notifications.systemAlertsEnabled}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      notifications: {
                        ...settings.notifications,
                        systemAlertsEnabled: e.target.checked,
                      },
                    })
                  }
                />
                <div>
                  <span className="text-sm font-medium">システムアラート</span>
                  <p className="text-xs text-gray-500">
                    システムの警告やエラーを通知します
                  </p>
                </div>
              </label>
              <label className="flex items-center space-x-3 cursor-pointer">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
                  checked={
                    settings.notifications.maintenanceNotificationsEnabled
                  }
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      notifications: {
                        ...settings.notifications,
                        maintenanceNotificationsEnabled: e.target.checked,
                      },
                    })
                  }
                />
                <div>
                  <span className="text-sm font-medium">メンテナンス通知</span>
                  <p className="text-xs text-gray-500">
                    予定されているメンテナンスを通知します
                  </p>
                </div>
              </label>
            </div>
          </div>
        </section>

        {/* セキュリティ設定（読み取り専用） */}
        <section className="rounded-xl border bg-card text-card-foreground shadow">
          <div className="flex flex-col space-y-1.5 p-6 border-b">
            <h2 className="text-lg font-semibold leading-none tracking-tight">
              セキュリティ設定
            </h2>
            <p className="text-sm text-muted-foreground text-gray-500">
              セキュリティに関する設定を確認できます
            </p>
          </div>
          <div className="p-6">
            <dl className="grid gap-4 md:grid-cols-3">
              <div className="space-y-1">
                <dt className="text-sm font-medium text-gray-500">MFA 必須</dt>
                <dd className="text-sm">
                  {settings.security.mfaRequired ? '有効' : '無効'}
                </dd>
              </div>
              <div className="space-y-1">
                <dt className="text-sm font-medium text-gray-500">
                  セッションタイムアウト
                </dt>
                <dd className="text-sm">
                  {settings.security.sessionTimeoutMinutes} 分
                </dd>
              </div>
              <div className="space-y-1">
                <dt className="text-sm font-medium text-gray-500">
                  最大ログイン試行回数
                </dt>
                <dd className="text-sm">
                  {settings.security.maxLoginAttempts} 回
                </dd>
              </div>
            </dl>
          </div>
        </section>
      </div>

      {/* 保存ボタン */}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={handleSave}
          disabled={isSaving}
          className="inline-flex items-center justify-center rounded-md bg-primary px-6 py-2 text-sm font-medium text-primary-foreground shadow hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 bg-black text-white"
        >
          {isSaving ? '保存中...' : '設定を保存'}
        </button>
      </div>
    </div>
  );
}
