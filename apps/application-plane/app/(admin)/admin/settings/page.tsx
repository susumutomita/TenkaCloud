/**
 * Admin Settings Page
 *
 * HybridNext Design System - Terminal Command Center style
 * テナント設定
 */

'use client';

import { useId, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
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
  const teamRegistrationId = useId();
  const individualRegistrationId = useId();
  const emailVerificationId = useId();

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
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-text-primary flex items-center gap-3">
          <span className="text-hn-accent font-mono">&gt;_</span>
          設定
        </h1>
        <Button onClick={handleSave} disabled={saving}>
          {saving ? (
            <>
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-current mr-2" />
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
        </Button>
      </div>

      {/* General Settings */}
      <Card>
        <CardContent className="p-6">
          <h2 className="text-lg font-semibold text-text-primary mb-6 flex items-center gap-2">
            <svg
              className="w-5 h-5 text-hn-accent"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
              />
            </svg>
            基本設定
          </h2>
          <div className="space-y-6">
            <div>
              <label
                htmlFor={tenantNameId}
                className="block text-sm font-medium text-text-secondary mb-1"
              >
                テナント名
              </label>
              <Input
                id={tenantNameId}
                type="text"
                value={settings.tenantName}
                onChange={(e) =>
                  setSettings({ ...settings, tenantName: e.target.value })
                }
                className="max-w-md"
              />
            </div>

            <div>
              <label
                htmlFor={contactEmailId}
                className="block text-sm font-medium text-text-secondary mb-1"
              >
                連絡先メールアドレス
              </label>
              <Input
                id={contactEmailId}
                type="email"
                value={settings.contactEmail}
                onChange={(e) =>
                  setSettings({ ...settings, contactEmail: e.target.value })
                }
                className="max-w-md"
              />
              <p className="mt-1 text-sm text-text-muted">
                システム通知の送信先として使用されます。
              </p>
            </div>

            <div>
              <label
                htmlFor={defaultCloudProviderId}
                className="block text-sm font-medium text-text-secondary mb-1"
              >
                デフォルトクラウドプロバイダー
              </label>
              <Select
                id={defaultCloudProviderId}
                value={settings.defaultCloudProvider}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    defaultCloudProvider: e.target.value,
                  })
                }
                options={[
                  { value: 'aws', label: 'AWS' },
                  { value: 'gcp', label: 'Google Cloud' },
                  { value: 'azure', label: 'Microsoft Azure' },
                ]}
                className="max-w-md"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Event Settings */}
      <Card>
        <CardContent className="p-6">
          <h2 className="text-lg font-semibold text-text-primary mb-6 flex items-center gap-2">
            <svg
              className="w-5 h-5 text-hn-purple"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
              />
            </svg>
            イベント設定
          </h2>
          <div className="space-y-6">
            <div>
              <label
                htmlFor={maxParticipantsId}
                className="block text-sm font-medium text-text-secondary mb-1"
              >
                イベントあたりの最大参加者数
              </label>
              <Input
                id={maxParticipantsId}
                type="number"
                min={1}
                max={1000}
                value={settings.maxParticipantsPerEvent}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    maxParticipantsPerEvent: Number.parseInt(
                      e.target.value,
                      10
                    ),
                  })
                }
                className="w-32"
              />
            </div>

            <div>
              <label
                htmlFor={maxTeamSizeId}
                className="block text-sm font-medium text-text-secondary mb-1"
              >
                最大チームサイズ
              </label>
              <Input
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
                className="w-32"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Registration Settings */}
      <Card>
        <CardContent className="p-6">
          <h2 className="text-lg font-semibold text-text-primary mb-6 flex items-center gap-2">
            <svg
              className="w-5 h-5 text-hn-success"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z"
              />
            </svg>
            登録設定
          </h2>
          <div className="space-y-4">
            <label
              htmlFor={teamRegistrationId}
              className="flex items-center cursor-pointer group"
            >
              <input
                id={teamRegistrationId}
                type="checkbox"
                checked={settings.enableTeamRegistration}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    enableTeamRegistration: e.target.checked,
                  })
                }
                className="h-4 w-4 text-hn-accent bg-surface-1 border-border rounded focus:ring-hn-accent focus:ring-offset-surface-0"
              />
              <span className="ml-3 text-sm text-text-secondary group-hover:text-text-primary transition-colors">
                チーム登録を許可する
              </span>
            </label>

            <label
              htmlFor={individualRegistrationId}
              className="flex items-center cursor-pointer group"
            >
              <input
                id={individualRegistrationId}
                type="checkbox"
                checked={settings.enableIndividualRegistration}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    enableIndividualRegistration: e.target.checked,
                  })
                }
                className="h-4 w-4 text-hn-accent bg-surface-1 border-border rounded focus:ring-hn-accent focus:ring-offset-surface-0"
              />
              <span className="ml-3 text-sm text-text-secondary group-hover:text-text-primary transition-colors">
                個人登録を許可する
              </span>
            </label>

            <label
              htmlFor={emailVerificationId}
              className="flex items-center cursor-pointer group"
            >
              <input
                id={emailVerificationId}
                type="checkbox"
                checked={settings.requireEmailVerification}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    requireEmailVerification: e.target.checked,
                  })
                }
                className="h-4 w-4 text-hn-accent bg-surface-1 border-border rounded focus:ring-hn-accent focus:ring-offset-surface-0"
              />
              <span className="ml-3 text-sm text-text-secondary group-hover:text-text-primary transition-colors">
                メール認証を必須にする
              </span>
            </label>
          </div>
        </CardContent>
      </Card>

      {/* Danger Zone */}
      <Card className="border-hn-error/30">
        <CardContent className="p-6">
          <h2 className="text-lg font-semibold text-hn-error mb-4 flex items-center gap-2">
            <svg
              className="w-5 h-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>
            危険な操作
          </h2>
          <div className="space-y-4">
            <div className="flex items-center justify-between p-4 bg-hn-error/10 rounded-lg border border-hn-error/20">
              <div>
                <h3 className="text-sm font-medium text-text-primary">
                  全データを削除
                </h3>
                <p className="text-sm text-text-muted">
                  すべてのイベント、参加者、チームデータを削除します。この操作は取り消せません。
                </p>
              </div>
              <Button
                variant="danger"
                size="sm"
                onClick={() => {
                  // TODO: Implement delete confirmation
                }}
              >
                削除
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Terminal-style footer */}
      <div className="text-center text-text-muted text-xs font-mono py-4">
        <span className="text-hn-accent">$</span> config --tenant=
        {settings.tenantName || 'default'}
      </div>
    </div>
  );
}
