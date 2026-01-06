/**
 * Admin Settings Page
 *
 * テナント設定
 */

'use client';

import { useId, useState } from 'react';
import { useTenantOptional } from '@/lib/tenant';

export default function AdminSettingsPage() {
  const tenant = useTenantOptional();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Form field IDs
  const tenantNameId = useId();
  const contactEmailId = useId();
  const defaultCloudProviderId = useId();
  const maxParticipantsId = useId();
  const maxTeamSizeId = useId();

  // Form state
  const [settings, setSettings] = useState({
    tenantName: tenant?.slug || '',
    contactEmail: 'admin@example.com',
    defaultCloudProvider: 'aws',
    maxParticipantsPerEvent: 100,
    maxTeamSize: 5,
    enableTeamRegistration: true,
    enableIndividualRegistration: true,
    requireEmailVerification: true,
  });

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    try {
      // TODO: Implement actual save logic
      await new Promise((resolve) => setTimeout(resolve, 1000));
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">設定</h1>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
        >
          {saving ? (
            <>
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2" />
              保存中...
            </>
          ) : saved ? (
            <>
              <svg
                className="w-5 h-5 mr-2"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 13l4 4L19 7"
                />
              </svg>
              保存しました
            </>
          ) : (
            '変更を保存'
          )}
        </button>
      </div>

      {/* General Settings */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-6">基本設定</h2>
        <div className="space-y-6">
          <div>
            <label
              htmlFor={tenantNameId}
              className="block text-sm font-medium text-gray-700 mb-1"
            >
              テナント名
            </label>
            <input
              id={tenantNameId}
              type="text"
              value={settings.tenantName}
              onChange={(e) =>
                setSettings({ ...settings, tenantName: e.target.value })
              }
              className="block w-full max-w-md border border-gray-300 rounded-lg px-3 py-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>

          <div>
            <label
              htmlFor={contactEmailId}
              className="block text-sm font-medium text-gray-700 mb-1"
            >
              連絡先メールアドレス
            </label>
            <input
              id={contactEmailId}
              type="email"
              value={settings.contactEmail}
              onChange={(e) =>
                setSettings({ ...settings, contactEmail: e.target.value })
              }
              className="block w-full max-w-md border border-gray-300 rounded-lg px-3 py-2 focus:ring-blue-500 focus:border-blue-500"
            />
            <p className="mt-1 text-sm text-gray-500">
              システム通知の送信先として使用されます。
            </p>
          </div>

          <div>
            <label
              htmlFor={defaultCloudProviderId}
              className="block text-sm font-medium text-gray-700 mb-1"
            >
              デフォルトクラウドプロバイダー
            </label>
            <select
              id={defaultCloudProviderId}
              value={settings.defaultCloudProvider}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  defaultCloudProvider: e.target.value,
                })
              }
              className="block w-full max-w-md border border-gray-300 rounded-lg px-3 py-2 focus:ring-blue-500 focus:border-blue-500"
            >
              <option value="aws">AWS</option>
              <option value="gcp">Google Cloud</option>
              <option value="azure">Microsoft Azure</option>
            </select>
          </div>
        </div>
      </div>

      {/* Event Settings */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-6">
          イベント設定
        </h2>
        <div className="space-y-6">
          <div>
            <label
              htmlFor={maxParticipantsId}
              className="block text-sm font-medium text-gray-700 mb-1"
            >
              イベントあたりの最大参加者数
            </label>
            <input
              id={maxParticipantsId}
              type="number"
              min={1}
              max={1000}
              value={settings.maxParticipantsPerEvent}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  maxParticipantsPerEvent: Number.parseInt(e.target.value, 10),
                })
              }
              className="block w-32 border border-gray-300 rounded-lg px-3 py-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>

          <div>
            <label
              htmlFor={maxTeamSizeId}
              className="block text-sm font-medium text-gray-700 mb-1"
            >
              最大チームサイズ
            </label>
            <input
              id={maxTeamSizeId}
              type="number"
              min={1}
              max={10}
              value={settings.maxTeamSize}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  maxTeamSize: Number.parseInt(e.target.value, 10),
                })
              }
              className="block w-32 border border-gray-300 rounded-lg px-3 py-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
        </div>
      </div>

      {/* Registration Settings */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-6">登録設定</h2>
        <div className="space-y-4">
          <label className="flex items-center">
            <input
              type="checkbox"
              checked={settings.enableTeamRegistration}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  enableTeamRegistration: e.target.checked,
                })
              }
              className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
            />
            <span className="ml-3 text-sm text-gray-700">
              チーム登録を許可する
            </span>
          </label>

          <label className="flex items-center">
            <input
              type="checkbox"
              checked={settings.enableIndividualRegistration}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  enableIndividualRegistration: e.target.checked,
                })
              }
              className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
            />
            <span className="ml-3 text-sm text-gray-700">
              個人登録を許可する
            </span>
          </label>

          <label className="flex items-center">
            <input
              type="checkbox"
              checked={settings.requireEmailVerification}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  requireEmailVerification: e.target.checked,
                })
              }
              className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
            />
            <span className="ml-3 text-sm text-gray-700">
              メール認証を必須にする
            </span>
          </label>
        </div>
      </div>

      {/* Danger Zone */}
      <div className="bg-white rounded-lg shadow-sm border border-red-200 p-6">
        <h2 className="text-lg font-semibold text-red-600 mb-4">危険な操作</h2>
        <div className="space-y-4">
          <div className="flex items-center justify-between p-4 bg-red-50 rounded-lg">
            <div>
              <h3 className="text-sm font-medium text-gray-900">
                全データを削除
              </h3>
              <p className="text-sm text-gray-500">
                すべてのイベント、参加者、チームデータを削除します。この操作は取り消せません。
              </p>
            </div>
            <button
              type="button"
              className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 text-sm font-medium"
            >
              削除
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
