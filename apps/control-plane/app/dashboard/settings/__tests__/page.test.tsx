import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SettingsPage from '../page';

vi.mock('@/lib/api/settings-api', () => ({
  saveSettings: vi.fn(),
}));

import { saveSettings } from '@/lib/api/settings-api';

const mockSaveSettings = vi.mocked(saveSettings);

describe('SettingsPage コンポーネント', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // デフォルトでは成功するように設定
    mockSaveSettings.mockResolvedValue(undefined);
  });

  it('タイトルを表示すべき', () => {
    render(<SettingsPage />);
    expect(screen.getByText('設定')).toBeInTheDocument();
  });

  it('説明文を表示すべき', () => {
    render(<SettingsPage />);
    expect(
      screen.getByText('プラットフォームの設定を管理します')
    ).toBeInTheDocument();
  });

  describe('プラットフォーム設定', () => {
    it('プラットフォーム設定セクションを表示すべき', () => {
      render(<SettingsPage />);
      expect(screen.getByText('プラットフォーム設定')).toBeInTheDocument();
      expect(
        screen.getByText('基本的なプラットフォームの設定を行います')
      ).toBeInTheDocument();
    });

    it('プラットフォーム名入力フィールドを表示すべき', () => {
      render(<SettingsPage />);
      expect(screen.getByLabelText('プラットフォーム名')).toBeInTheDocument();
    });

    it('プラットフォーム名を変更できるべき', async () => {
      const user = userEvent.setup();
      render(<SettingsPage />);

      const input = screen.getByLabelText('プラットフォーム名');
      await user.clear(input);
      await user.type(input, 'New Platform');

      expect((input as HTMLInputElement).value).toBe('New Platform');
    });

    it('言語選択を表示すべき', () => {
      render(<SettingsPage />);
      expect(screen.getByLabelText('言語')).toBeInTheDocument();
    });

    it('言語を変更できるべき', async () => {
      const user = userEvent.setup();
      render(<SettingsPage />);

      const languageSelect = screen.getByLabelText('言語');
      await user.selectOptions(languageSelect, 'en');

      expect((languageSelect as HTMLSelectElement).value).toBe('en');
    });

    it('タイムゾーン選択を表示すべき', () => {
      render(<SettingsPage />);
      expect(screen.getByLabelText('タイムゾーン')).toBeInTheDocument();
    });

    it('タイムゾーンを変更できるべき', async () => {
      const user = userEvent.setup();
      render(<SettingsPage />);

      const timezoneSelect = screen.getByLabelText('タイムゾーン');
      await user.selectOptions(timezoneSelect, 'UTC');

      expect((timezoneSelect as HTMLSelectElement).value).toBe('UTC');
    });
  });

  describe('外観設定', () => {
    it('外観設定セクションを表示すべき', () => {
      render(<SettingsPage />);
      expect(screen.getByText('外観設定')).toBeInTheDocument();
      expect(
        screen.getByText('アプリケーションの表示設定を行います')
      ).toBeInTheDocument();
    });

    it('テーマ選択を表示すべき', () => {
      render(<SettingsPage />);
      expect(screen.getByLabelText('テーマ')).toBeInTheDocument();
    });

    it('テーマを変更できるべき', async () => {
      const user = userEvent.setup();
      render(<SettingsPage />);

      const themeSelect = screen.getByLabelText('テーマ');
      await user.selectOptions(themeSelect, 'dark');

      expect((themeSelect as HTMLSelectElement).value).toBe('dark');
    });
  });

  describe('通知設定', () => {
    it('通知設定セクションを表示すべき', () => {
      render(<SettingsPage />);
      expect(screen.getByText('通知設定')).toBeInTheDocument();
      expect(screen.getByText('通知の受信設定を行います')).toBeInTheDocument();
    });

    it('メール通知チェックボックスを表示すべき', () => {
      render(<SettingsPage />);
      expect(screen.getByText('メール通知')).toBeInTheDocument();
    });

    it('メール通知のオン/オフを切り替えられるべき', async () => {
      const user = userEvent.setup();
      render(<SettingsPage />);

      const checkboxes = screen.getAllByRole('checkbox');
      const emailCheckbox = checkboxes[0]; // 1番目のチェックボックス

      // 初期状態はチェック済み
      expect(emailCheckbox).toBeChecked();

      // クリックしてオフにする
      await user.click(emailCheckbox);
      expect(emailCheckbox).not.toBeChecked();
    });

    it('システムアラートチェックボックスを表示すべき', () => {
      render(<SettingsPage />);
      expect(screen.getByText('システムアラート')).toBeInTheDocument();
    });

    it('メンテナンス通知チェックボックスを表示すべき', () => {
      render(<SettingsPage />);
      expect(screen.getByText('メンテナンス通知')).toBeInTheDocument();
    });

    it('システムアラートのオン/オフを切り替えられるべき', async () => {
      const user = userEvent.setup();
      render(<SettingsPage />);

      const checkboxes = screen.getAllByRole('checkbox');
      const systemAlertsCheckbox = checkboxes[1]; // 2番目のチェックボックス

      // 初期状態はチェック済み
      expect(systemAlertsCheckbox).toBeChecked();

      // クリックしてオフにする
      await user.click(systemAlertsCheckbox);
      expect(systemAlertsCheckbox).not.toBeChecked();
    });

    it('メンテナンス通知のオン/オフを切り替えられるべき', async () => {
      const user = userEvent.setup();
      render(<SettingsPage />);

      const checkboxes = screen.getAllByRole('checkbox');
      const maintenanceCheckbox = checkboxes[2]; // 3番目のチェックボックス

      // 初期状態はチェック済み
      expect(maintenanceCheckbox).toBeChecked();

      // クリックしてオフにする
      await user.click(maintenanceCheckbox);
      expect(maintenanceCheckbox).not.toBeChecked();
    });
  });

  describe('セキュリティ設定', () => {
    it('セキュリティ設定セクションを表示すべき', () => {
      render(<SettingsPage />);
      expect(screen.getByText('セキュリティ設定')).toBeInTheDocument();
    });

    it('MFA必須の値を表示すべき', () => {
      render(<SettingsPage />);
      expect(screen.getByText('MFA 必須')).toBeInTheDocument();
    });

    it('MFA必須が有効の場合、有効と表示すべき', () => {
      const customSettings = {
        platform: {
          platformName: 'TenkaCloud',
          language: 'ja' as const,
          timezone: 'Asia/Tokyo',
        },
        appearance: { theme: 'light' as const },
        notifications: {
          emailNotificationsEnabled: true,
          systemAlertsEnabled: true,
          maintenanceNotificationsEnabled: true,
        },
        security: {
          mfaRequired: true,
          sessionTimeoutMinutes: 30,
          maxLoginAttempts: 5,
        },
      };
      render(<SettingsPage initialSettings={customSettings} />);
      expect(screen.getByText('有効')).toBeInTheDocument();
    });

    it('セッションタイムアウトの値を表示すべき', () => {
      render(<SettingsPage />);
      expect(screen.getByText('セッションタイムアウト')).toBeInTheDocument();
    });

    it('最大ログイン試行回数の値を表示すべき', () => {
      render(<SettingsPage />);
      expect(screen.getByText('最大ログイン試行回数')).toBeInTheDocument();
    });
  });

  describe('保存ボタン', () => {
    it('保存ボタンを表示すべき', () => {
      render(<SettingsPage />);
      expect(
        screen.getByRole('button', { name: '設定を保存' })
      ).toBeInTheDocument();
    });

    it('保存ボタンをクリックすると保存中状態になるべき', async () => {
      // 解決を遅延させるPromiseを使用
      let resolvePromise: () => void;
      mockSaveSettings.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolvePromise = resolve;
          })
      );

      const user = userEvent.setup();
      render(<SettingsPage />);

      const saveButton = screen.getByRole('button', { name: '設定を保存' });
      await user.click(saveButton);

      expect(screen.getByText('保存中...')).toBeInTheDocument();

      // Promiseを解決してクリーンアップ
      resolvePromise!();
      await waitFor(() => {
        expect(screen.getByText('設定を保存')).toBeInTheDocument();
      });
    });

    it('保存成功時に成功メッセージを表示すべき', async () => {
      const user = userEvent.setup();
      render(<SettingsPage />);

      const saveButton = screen.getByRole('button', { name: '設定を保存' });
      await user.click(saveButton);

      // 保存処理完了後に成功メッセージが表示される
      await waitFor(
        () => {
          expect(screen.getByText('設定を保存しました')).toBeInTheDocument();
        },
        { timeout: 1000 }
      );
    });

    it('保存失敗時にエラーメッセージを表示すべき', async () => {
      mockSaveSettings.mockRejectedValue(new Error('API Error'));
      const user = userEvent.setup();
      render(<SettingsPage />);

      const saveButton = screen.getByRole('button', { name: '設定を保存' });
      await user.click(saveButton);

      // 保存処理失敗後にエラーメッセージが表示される
      await waitFor(() => {
        expect(
          screen.getByText('設定の保存に失敗しました')
        ).toBeInTheDocument();
      });
    });
  });
});
