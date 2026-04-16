import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AdminProblemCreatePage from '../page';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  useParams: () => ({}),
}));
const mockPost = vi.fn();
vi.mock('@/lib/api/client', () => ({
  post: (...args: unknown[]) => mockPost(...args),
}));

describe('問題作成ページ', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('フォームのヘッダー「新規問題作成」が表示されるべき', () => {
    render(<AdminProblemCreatePage />);
    expect(screen.getByText('新規問題作成')).toBeInTheDocument();
  });
  it('基本情報セクションが表示されるべき', () => {
    render(<AdminProblemCreatePage />);
    expect(screen.getByText('基本情報')).toBeInTheDocument();
    expect(screen.getByText('タイトル')).toBeInTheDocument();
    expect(screen.getByText('タイプ')).toBeInTheDocument();
    expect(screen.getByText('カテゴリ')).toBeInTheDocument();
    expect(screen.getByText('難易度')).toBeInTheDocument();
  });
  it('説明セクションが表示されるべき', () => {
    render(<AdminProblemCreatePage />);
    expect(screen.getByText('説明')).toBeInTheDocument();
    expect(screen.getByText('概要')).toBeInTheDocument();
    expect(screen.getByText('目標')).toBeInTheDocument();
    expect(screen.getByText('推定時間（分）')).toBeInTheDocument();
  });
  it('デプロイメントセクションが表示されるべき', () => {
    render(<AdminProblemCreatePage />);
    expect(screen.getByText('デプロイメント')).toBeInTheDocument();
    expect(screen.getByText('対応プロバイダー')).toBeInTheDocument();
    expect(screen.getByText('リージョン')).toBeInTheDocument();
  });
  it('採点設定セクションが表示されるべき', () => {
    render(<AdminProblemCreatePage />);
    expect(screen.getByText('採点設定')).toBeInTheDocument();
    expect(screen.getByText('採点方式')).toBeInTheDocument();
    expect(screen.getByText('採点基準')).toBeInTheDocument();
  });
  it('メタデータセクションが表示されるべき', () => {
    render(<AdminProblemCreatePage />);
    expect(screen.getByText('メタデータ')).toBeInTheDocument();
    expect(screen.getByText('作成者')).toBeInTheDocument();
    expect(screen.getByText('バージョン')).toBeInTheDocument();
    expect(screen.getByText('タグ')).toBeInTheDocument();
  });
  it('作成ボタンが表示されるべき', () => {
    render(<AdminProblemCreatePage />);
    const buttons = screen.getAllByRole('button', { name: '作成' });
    expect(buttons.length).toBeGreaterThan(0);
  });
  it('問題一覧に戻るリンクが表示されるべき', () => {
    render(<AdminProblemCreatePage />);
    expect(screen.getByText('問題一覧に戻る')).toBeInTheDocument();
  });
  it('タイトルが空の場合にバリデーションエラーを表示すべき', async () => {
    render(<AdminProblemCreatePage />);
    await userEvent.click(screen.getAllByRole('button', { name: '作成' })[0]);
    await waitFor(() => {
      expect(screen.getByText('タイトルは必須です')).toBeInTheDocument();
    });
    expect(mockPost).not.toHaveBeenCalled();
  });
  it('概要が空の場合にバリデーションエラーを表示すべき', async () => {
    render(<AdminProblemCreatePage />);
    await userEvent.type(
      screen.getByPlaceholderText('問題のタイトルを入力'),
      'テスト問題',
    );
    await userEvent.click(screen.getAllByRole('button', { name: '作成' })[0]);
    await waitFor(() => {
      expect(screen.getByText('概要は必須です')).toBeInTheDocument();
    });
    expect(mockPost).not.toHaveBeenCalled();
  });
  it('正常送信時に POST API を呼び出してリダイレクトすべき', async () => {
    mockPost.mockResolvedValue({ id: 'prob-1' });
    render(<AdminProblemCreatePage />);
    await userEvent.type(
      screen.getByPlaceholderText('問題のタイトルを入力'),
      'テスト問題',
    );
    await userEvent.type(
      screen.getByPlaceholderText('問題の概要を入力'),
      'テスト概要',
    );
    await userEvent.click(screen.getAllByRole('button', { name: '作成' })[0]);
    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledWith(
        '/admin/problems',
        expect.objectContaining({ title: 'テスト問題' }),
      );
    });
    expect(mockPush).toHaveBeenCalledWith('/admin/problems');
  });
  it('API エラー時にエラーメッセージを表示すべき', async () => {
    mockPost.mockRejectedValue(new Error('サーバーエラー'));
    render(<AdminProblemCreatePage />);
    await userEvent.type(
      screen.getByPlaceholderText('問題のタイトルを入力'),
      'テスト問題',
    );
    await userEvent.type(
      screen.getByPlaceholderText('問題の概要を入力'),
      'テスト概要',
    );
    await userEvent.click(screen.getAllByRole('button', { name: '作成' })[0]);
    await waitFor(() => {
      expect(screen.getByText('サーバーエラー')).toBeInTheDocument();
    });
    expect(mockPush).not.toHaveBeenCalled();
  });
  it('Error 以外の例外が投げられた場合もエラーメッセージを表示すべき', async () => {
    mockPost.mockRejectedValue('unknown');
    render(<AdminProblemCreatePage />);
    await userEvent.type(
      screen.getByPlaceholderText('問題のタイトルを入力'),
      'テスト',
    );
    await userEvent.type(
      screen.getByPlaceholderText('問題の概要を入力'),
      'テスト概要',
    );
    await userEvent.click(screen.getAllByRole('button', { name: '作成' })[0]);
    await waitFor(() => {
      expect(screen.getByText('送信に失敗しました')).toBeInTheDocument();
    });
  });
  it('目標の追加ボタンで入力欄が増えるべき', async () => {
    render(<AdminProblemCreatePage />);
    await userEvent.click(screen.getAllByRole('button', { name: '+ 追加' })[0]);
    expect(screen.getAllByPlaceholderText(/目標 \d+/).length).toBe(2);
  });
  it('目標の削除ボタンで入力欄が減るべき', async () => {
    render(<AdminProblemCreatePage />);
    await userEvent.click(screen.getAllByRole('button', { name: '+ 追加' })[0]);
    await userEvent.click(screen.getAllByRole('button', { name: '削除' })[0]);
    expect(screen.getAllByPlaceholderText(/目標 \d+/).length).toBe(1);
  });
  it('タグを追加できるべき', async () => {
    render(<AdminProblemCreatePage />);
    await userEvent.type(
      screen.getByPlaceholderText('タグを入力してEnter'),
      'aws',
    );
    await userEvent.click(screen.getByRole('button', { name: '追加' }));
    expect(screen.getByText('aws')).toBeInTheDocument();
  });
  it('タグをEnterキーで追加できるべき', async () => {
    render(<AdminProblemCreatePage />);
    await userEvent.type(
      screen.getByPlaceholderText('タグを入力してEnter'),
      'security{Enter}',
    );
    expect(screen.getByText('security')).toBeInTheDocument();
  });
  it('タグを削除できるべき', async () => {
    render(<AdminProblemCreatePage />);
    await userEvent.type(
      screen.getByPlaceholderText('タグを入力してEnter'),
      'test-tag{Enter}',
    );
    expect(screen.getByText('test-tag')).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText('タグ「test-tag」を削除'));
    expect(screen.queryByText('test-tag')).not.toBeInTheDocument();
  });
  it('プロバイダーを切り替えられるべき', async () => {
    render(<AdminProblemCreatePage />);
    const gcpButton = screen.getByRole('button', { name: 'GCP' });
    await userEvent.click(gcpButton);
    expect(gcpButton.className).toContain('border-hn-accent');
  });
  it('採点基準を追加できるべき', async () => {
    render(<AdminProblemCreatePage />);
    await userEvent.click(screen.getAllByRole('button', { name: '+ 追加' })[1]);
    expect(screen.getAllByText(/基準 \d+/).length).toBe(2);
  });
  it('プロバイダーが未選択の場合にバリデーションエラーを表示すべき', async () => {
    render(<AdminProblemCreatePage />);
    await userEvent.type(
      screen.getByPlaceholderText('問題のタイトルを入力'),
      'テスト問題',
    );
    await userEvent.type(
      screen.getByPlaceholderText('問題の概要を入力'),
      'テスト概要',
    );
    await userEvent.click(screen.getByRole('button', { name: 'AWS' }));
    await userEvent.click(screen.getAllByRole('button', { name: '作成' })[0]);
    await waitFor(() => {
      expect(
        screen.getByText('プロバイダーを1つ以上選択してください'),
      ).toBeInTheDocument();
    });
  });
});
