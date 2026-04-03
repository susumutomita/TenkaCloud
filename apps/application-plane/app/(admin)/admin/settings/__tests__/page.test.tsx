import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import AdminSettingsPage from '../page';

const mockGet = vi.fn();
const mockPut = vi.fn();
const mockPost = vi.fn();

vi.mock('@/lib/api/client', () => ({
  get: (...args: unknown[]) => mockGet(...args),
  put: (...args: unknown[]) => mockPut(...args),
  post: (...args: unknown[]) => mockPost(...args),
}));

const settingsData = {
  tenantName: 'テスト組織',
  slug: 'test-org',
  apiKey: 'sk-abcdefgh1234',
};

function getTab(name: string) {
  return screen.getByRole('tab', { name });
}

describe('Admin 設定ページ', () => {
  let clipboardWriteText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue(settingsData);
    clipboardWriteText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: clipboardWriteText },
      writable: true,
      configurable: true,
    });
  });

  it('タブが表示されるべき', async () => {
    render(<AdminSettingsPage />);
    await waitFor(() => {
      expect(getTab('一般設定')).toBeInTheDocument();
    });
    expect(getTab('API キー')).toBeInTheDocument();
    expect(getTab('危険ゾーン')).toBeInTheDocument();
  });

  it('ページタイトル「設定」が表示されるべき', async () => {
    render(<AdminSettingsPage />);
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: '設定', level: 1 }),
      ).toBeInTheDocument();
    });
  });

  it('一般設定タブでテナント名とスラッグを表示すべき', async () => {
    render(<AdminSettingsPage />);
    await waitFor(() => {
      expect(screen.getByDisplayValue('テスト組織')).toBeInTheDocument();
    });
    expect(screen.getByDisplayValue('test-org')).toBeInTheDocument();
  });

  it('一般設定フォームを送信すべき', async () => {
    const user = userEvent.setup();
    mockPut.mockResolvedValue({
      tenantName: '新しい組織',
      slug: 'new-org',
      apiKey: 'sk-abcdefgh1234',
    });
    render(<AdminSettingsPage />);
    await waitFor(() => {
      expect(screen.getByDisplayValue('テスト組織')).toBeInTheDocument();
    });
    const nameInput = screen.getByDisplayValue('テスト組織');
    await user.clear(nameInput);
    await user.type(nameInput, '新しい組織');
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => {
      expect(mockPut).toHaveBeenCalledWith('/admin/settings', {
        tenantName: '新しい組織',
        slug: 'test-org',
      });
    });
  });

  it('保存成功時にメッセージを表示すべき', async () => {
    const user = userEvent.setup();
    mockPut.mockResolvedValue(settingsData);
    render(<AdminSettingsPage />);
    await waitFor(() => {
      expect(screen.getByDisplayValue('テスト組織')).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => {
      expect(screen.getByText('設定を保存しました')).toBeInTheDocument();
    });
  });

  it('保存エラー時にエラーメッセージを表示すべき', async () => {
    const user = userEvent.setup();
    mockPut.mockRejectedValue(new Error('保存に失敗'));
    render(<AdminSettingsPage />);
    await waitFor(() => {
      expect(screen.getByDisplayValue('テスト組織')).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => {
      expect(screen.getByText('保存に失敗')).toBeInTheDocument();
    });
  });

  it('保存時に Error 以外の例外でデフォルトメッセージを表示すべき', async () => {
    const user = userEvent.setup();
    mockPut.mockRejectedValue('string error');
    render(<AdminSettingsPage />);
    await waitFor(() => {
      expect(screen.getByDisplayValue('テスト組織')).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => {
      expect(screen.getByText('設定の保存に失敗しました')).toBeInTheDocument();
    });
  });

  it('API キータブでマスクされた API キーを表示すべき', async () => {
    const user = userEvent.setup();
    render(<AdminSettingsPage />);
    await waitFor(() => {
      expect(getTab('API キー')).toBeInTheDocument();
    });
    await user.click(getTab('API キー'));
    await waitFor(() => {
      expect(screen.getByTestId('masked-api-key').textContent).toBe(
        'sk-****1234',
      );
    });
  });

  it('API キー再生成を実行すべき', async () => {
    const user = userEvent.setup();
    mockPost.mockResolvedValue({ ...settingsData, apiKey: 'sk-newkey5678' });
    render(<AdminSettingsPage />);
    await waitFor(() => {
      expect(getTab('API キー')).toBeInTheDocument();
    });
    await user.click(getTab('API キー'));
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'API キーを再生成' }),
      ).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: 'API キーを再生成' }));
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: '再生成' }),
      ).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: '再生成' }));
    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledWith('/admin/settings', {
        action: 'regenerate-api-key',
      });
    });
  });

  it('危険ゾーンタブで削除ボタンを表示すべき', async () => {
    const user = userEvent.setup();
    render(<AdminSettingsPage />);
    await waitFor(() => {
      expect(getTab('危険ゾーン')).toBeInTheDocument();
    });
    await user.click(getTab('危険ゾーン'));
    await waitFor(() => {
      expect(screen.getByText('全データを削除')).toBeInTheDocument();
    });
  });

  it('削除確認モーダルで DELETE 入力が必要であるべき', async () => {
    const user = userEvent.setup();
    render(<AdminSettingsPage />);
    await waitFor(() => {
      expect(getTab('危険ゾーン')).toBeInTheDocument();
    });
    await user.click(getTab('危険ゾーン'));
    await waitFor(() => {
      expect(screen.getByTestId('delete-all-data-button')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('delete-all-data-button'));
    await waitFor(() => {
      expect(
        screen.getByText('確認のため「DELETE」と入力してください'),
      ).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: '削除を実行' })).toBeDisabled();
  });

  it('DELETE 入力後に削除を実行すべき', async () => {
    const user = userEvent.setup();
    mockPost.mockResolvedValue({ success: true });
    render(<AdminSettingsPage />);
    await waitFor(() => {
      expect(getTab('危険ゾーン')).toBeInTheDocument();
    });
    await user.click(getTab('危険ゾーン'));
    await waitFor(() => {
      expect(screen.getByTestId('delete-all-data-button')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('delete-all-data-button'));
    await waitFor(() => {
      expect(screen.getByPlaceholderText('DELETE')).toBeInTheDocument();
    });
    await user.type(screen.getByPlaceholderText('DELETE'), 'DELETE');
    await user.click(screen.getByRole('button', { name: '削除を実行' }));
    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledWith('/admin/settings', {
        action: 'delete-all-data',
        confirmationToken: 'DELETE',
      });
    });
  });

  it('削除エラー時にエラーメッセージを表示すべき', async () => {
    const user = userEvent.setup();
    mockPost.mockRejectedValue(new Error('削除に失敗'));
    render(<AdminSettingsPage />);
    await waitFor(() => {
      expect(getTab('危険ゾーン')).toBeInTheDocument();
    });
    await user.click(getTab('危険ゾーン'));
    await waitFor(() => {
      expect(screen.getByTestId('delete-all-data-button')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('delete-all-data-button'));
    await waitFor(() => {
      expect(screen.getByPlaceholderText('DELETE')).toBeInTheDocument();
    });
    await user.type(screen.getByPlaceholderText('DELETE'), 'DELETE');
    await user.click(screen.getByRole('button', { name: '削除を実行' }));
    await waitFor(() => {
      expect(screen.getByText('削除に失敗')).toBeInTheDocument();
    });
  });

  it('削除時に Error 以外の例外でデフォルトメッセージを表示すべき', async () => {
    const user = userEvent.setup();
    mockPost.mockRejectedValue('string error');
    render(<AdminSettingsPage />);
    await waitFor(() => {
      expect(getTab('危険ゾーン')).toBeInTheDocument();
    });
    await user.click(getTab('危険ゾーン'));
    await waitFor(() => {
      expect(screen.getByTestId('delete-all-data-button')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('delete-all-data-button'));
    await waitFor(() => {
      expect(screen.getByPlaceholderText('DELETE')).toBeInTheDocument();
    });
    await user.type(screen.getByPlaceholderText('DELETE'), 'DELETE');
    await user.click(screen.getByRole('button', { name: '削除を実行' }));
    await waitFor(() => {
      expect(
        screen.getByText('データの削除に失敗しました'),
      ).toBeInTheDocument();
    });
  });

  it('設定取得エラー時もページが表示されるべき', async () => {
    mockGet.mockRejectedValue(new Error('Fetch failed'));
    render(<AdminSettingsPage />);
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: '設定', level: 1 }),
      ).toBeInTheDocument();
    });
    expect(getTab('一般設定')).toBeInTheDocument();
  });

  it('API キーが短い場合はそのまま表示すべき', async () => {
    const user = userEvent.setup();
    mockGet.mockResolvedValue({ ...settingsData, apiKey: 'short' });
    render(<AdminSettingsPage />);
    await waitFor(() => {
      expect(getTab('API キー')).toBeInTheDocument();
    });
    await user.click(getTab('API キー'));
    await waitFor(() => {
      expect(screen.getByTestId('masked-api-key').textContent).toBe('short');
    });
  });

  it('API キーが空の場合は空文字を表示すべき', async () => {
    const user = userEvent.setup();
    mockGet.mockResolvedValue({ ...settingsData, apiKey: '' });
    render(<AdminSettingsPage />);
    await waitFor(() => {
      expect(getTab('API キー')).toBeInTheDocument();
    });
    await user.click(getTab('API キー'));
    await waitFor(() => {
      expect(screen.getByTestId('masked-api-key').textContent).toBe('');
    });
  });

  it('クリップボード API 失敗時もエラーにならないべき', async () => {
    const user = userEvent.setup();
    clipboardWriteText.mockRejectedValue(new Error('Not allowed'));
    render(<AdminSettingsPage />);
    await waitFor(() => {
      expect(getTab('API キー')).toBeInTheDocument();
    });
    await user.click(getTab('API キー'));
    await waitFor(() => {
      expect(screen.getByLabelText('API キーをコピー')).toBeInTheDocument();
    });
    await user.click(screen.getByLabelText('API キーをコピー'));
    expect(getTab('API キー')).toBeInTheDocument();
  });

  it('API キー再生成でエラーが発生しても動作すべき', async () => {
    const user = userEvent.setup();
    mockPost.mockRejectedValue(new Error('Regenerate failed'));
    render(<AdminSettingsPage />);
    await waitFor(() => {
      expect(getTab('API キー')).toBeInTheDocument();
    });
    await user.click(getTab('API キー'));
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'API キーを再生成' }),
      ).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: 'API キーを再生成' }));
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: '再生成' }),
      ).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: '再生成' }));
    await waitFor(() => {
      expect(getTab('API キー')).toBeInTheDocument();
    });
  });
});
