import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AdminEventCreatePage from '../page';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  useParams: () => ({}),
}));
const mockPost = vi.fn();
vi.mock('@/lib/api/client', () => ({
  post: (...args: unknown[]) => mockPost(...args),
}));

describe('イベント作成ページ', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ヘッダー「イベント作成」が表示されるべき', () => {
    render(<AdminEventCreatePage />);
    expect(screen.getByText('イベント作成')).toBeInTheDocument();
  });

  it('基本情報セクションが表示されるべき', () => {
    render(<AdminEventCreatePage />);
    expect(screen.getByText('基本情報')).toBeInTheDocument();
    expect(screen.getByText('イベント名')).toBeInTheDocument();
    expect(screen.getByText('タイプ')).toBeInTheDocument();
    expect(screen.getByText('ステータス')).toBeInTheDocument();
  });

  it('日時設定フィールドが表示されるべき', () => {
    render(<AdminEventCreatePage />);
    expect(screen.getByText('開始日時')).toBeInTheDocument();
    expect(screen.getByText('終了日時')).toBeInTheDocument();
    expect(screen.getByText('タイムゾーン')).toBeInTheDocument();
  });

  it('参加設定セクションが表示されるべき', () => {
    render(<AdminEventCreatePage />);
    expect(screen.getByText('参加設定')).toBeInTheDocument();
    expect(screen.getByText('参加形式')).toBeInTheDocument();
    expect(screen.getByText('クラウドプロバイダー')).toBeInTheDocument();
    expect(screen.getByText('最大参加者数')).toBeInTheDocument();
    expect(screen.getByText('採点方式')).toBeInTheDocument();
  });

  it('作成ボタンが表示されるべき', () => {
    render(<AdminEventCreatePage />);
    expect(screen.getByRole('button', { name: '作成' })).toBeInTheDocument();
  });

  it('キャンセルボタンが表示されるべき', () => {
    render(<AdminEventCreatePage />);
    expect(
      screen.getByRole('button', { name: 'キャンセル' }),
    ).toBeInTheDocument();
  });

  it('キャンセルクリック時にイベント一覧へ遷移すべき', async () => {
    render(<AdminEventCreatePage />);
    await userEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    expect(mockPush).toHaveBeenCalledWith('/admin/events');
  });

  it('イベント名が空の場合にバリデーションエラーを表示すべき', async () => {
    render(<AdminEventCreatePage />);
    await userEvent.click(screen.getByRole('button', { name: '作成' }));
    await waitFor(() => {
      expect(screen.getByText('イベント名は必須です')).toBeInTheDocument();
    });
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('正常送信時に POST API を呼び出してリダイレクトすべき', async () => {
    mockPost.mockResolvedValue({ id: 'evt-1' });
    render(<AdminEventCreatePage />);
    await userEvent.type(
      screen.getByPlaceholderText('例: クラウドチャレンジ 2026 春'),
      'テストイベント',
    );
    await userEvent.click(screen.getByRole('button', { name: '作成' }));
    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledWith(
        '/admin/events',
        expect.objectContaining({
          name: 'テストイベント',
          slug: 'event',
          regions: ['ap-northeast-1'],
          scoringIntervalMinutes: 5,
          leaderboardVisible: true,
        }),
      );
    });
    expect(mockPush).toHaveBeenCalledWith('/admin/events');
  });

  it('API エラー時にエラーメッセージを表示すべき', async () => {
    mockPost.mockRejectedValue(new Error('作成に失敗しました'));
    render(<AdminEventCreatePage />);
    await userEvent.type(
      screen.getByPlaceholderText('例: クラウドチャレンジ 2026 春'),
      'テストイベント',
    );
    await userEvent.click(screen.getByRole('button', { name: '作成' }));
    await waitFor(() => {
      expect(screen.getByText('作成に失敗しました')).toBeInTheDocument();
    });
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('Error 以外の例外でもエラーメッセージを表示すべき', async () => {
    mockPost.mockRejectedValue('unknown');
    render(<AdminEventCreatePage />);
    await userEvent.type(
      screen.getByPlaceholderText('例: クラウドチャレンジ 2026 春'),
      'テストイベント',
    );
    await userEvent.click(screen.getByRole('button', { name: '作成' }));
    await waitFor(() => {
      expect(screen.getByText('エラーが発生しました')).toBeInTheDocument();
    });
  });

  it('デフォルトのタイプが Incident Drill であるべき', () => {
    render(<AdminEventCreatePage />);
    expect(screen.getByText('Incident Drill')).toBeInTheDocument();
  });

  it('デフォルトのステータスが下書きであるべき', () => {
    render(<AdminEventCreatePage />);
    expect(screen.getByText('下書き')).toBeInTheDocument();
  });
});
