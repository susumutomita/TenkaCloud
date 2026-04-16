import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AdminEventEditPage from '../page';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  useParams: () => ({ eventId: 'evt-456' }),
}));
const mockGet = vi.fn();
const mockPut = vi.fn();
vi.mock('@/lib/api/client', () => ({
  get: (...args: unknown[]) => mockGet(...args),
  put: (...args: unknown[]) => mockPut(...args),
}));

const mockEvent = {
  id: 'evt-456',
  name: '既存イベント',
  type: 'gameday',
  status: 'draft',
  startTime: '2026-05-01',
  endTime: '2026-05-02',
  timezone: 'Asia/Tokyo',
  participantType: 'team',
  cloudProvider: 'aws',
  maxParticipants: 200,
  scoringType: 'realtime',
};

describe('イベント編集ページ', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ローディング中にスピナーを表示すべき', () => {
    mockGet.mockReturnValue(new Promise(() => {}));
    render(<AdminEventEditPage />);
    expect(document.querySelector('[class*="awsui_root"]')).toBeInTheDocument();
  });

  it('データ取得後にフォームを表示すべき', async () => {
    mockGet.mockResolvedValue(mockEvent);
    render(<AdminEventEditPage />);
    await waitFor(() => {
      expect(screen.getByText('イベント編集')).toBeInTheDocument();
    });
  });

  it('API からイベントデータを取得すべき', async () => {
    mockGet.mockResolvedValue(mockEvent);
    render(<AdminEventEditPage />);
    await waitFor(() => {
      expect(mockGet).toHaveBeenCalledWith('/admin/events/evt-456');
    });
  });

  it('既存のイベント名がフォームに反映されるべき', async () => {
    mockGet.mockResolvedValue(mockEvent);
    render(<AdminEventEditPage />);
    await waitFor(() => {
      expect(screen.getByDisplayValue('既存イベント')).toBeInTheDocument();
    });
  });

  it('基本情報セクションが表示されるべき', async () => {
    mockGet.mockResolvedValue(mockEvent);
    render(<AdminEventEditPage />);
    await waitFor(() => {
      expect(screen.getByText('基本情報')).toBeInTheDocument();
    });
    expect(screen.getByText('イベント名')).toBeInTheDocument();
    expect(screen.getByText('タイプ')).toBeInTheDocument();
    expect(screen.getByText('ステータス')).toBeInTheDocument();
  });

  it('参加設定セクションが表示されるべき', async () => {
    mockGet.mockResolvedValue(mockEvent);
    render(<AdminEventEditPage />);
    await waitFor(() => {
      expect(screen.getByText('参加設定')).toBeInTheDocument();
    });
  });

  it('更新ボタンが表示されるべき', async () => {
    mockGet.mockResolvedValue(mockEvent);
    render(<AdminEventEditPage />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '更新' })).toBeInTheDocument();
    });
  });

  it('キャンセルボタンが表示されるべき', async () => {
    mockGet.mockResolvedValue(mockEvent);
    render(<AdminEventEditPage />);
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'キャンセル' }),
      ).toBeInTheDocument();
    });
  });

  it('キャンセルクリック時にイベント一覧へ遷移すべき', async () => {
    mockGet.mockResolvedValue(mockEvent);
    render(<AdminEventEditPage />);
    await waitFor(() => {
      expect(screen.getByText('イベント編集')).toBeInTheDocument();
    });
    await userEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    expect(mockPush).toHaveBeenCalledWith('/admin/events');
  });

  it('取得エラー時にエラーメッセージを表示すべき', async () => {
    mockGet.mockRejectedValue(new Error('Not Found'));
    render(<AdminEventEditPage />);
    await waitFor(() => {
      expect(screen.getByText('Not Found')).toBeInTheDocument();
    });
  });

  it('取得エラー時に「イベント一覧に戻る」ボタンが表示されるべき', async () => {
    mockGet.mockRejectedValue(new Error('Not Found'));
    render(<AdminEventEditPage />);
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'イベント一覧に戻る' }),
      ).toBeInTheDocument();
    });
  });

  it('Error 以外の取得エラーでもメッセージを表示すべき', async () => {
    mockGet.mockRejectedValue('network error');
    render(<AdminEventEditPage />);
    await waitFor(() => {
      expect(
        screen.getByText('イベントの取得に失敗しました'),
      ).toBeInTheDocument();
    });
  });

  it('正常送信時に PUT API を呼び出してリダイレクトすべき', async () => {
    mockGet.mockResolvedValue(mockEvent);
    mockPut.mockResolvedValue({ id: 'evt-456' });
    render(<AdminEventEditPage />);
    await waitFor(() => {
      expect(screen.getByDisplayValue('既存イベント')).toBeInTheDocument();
    });
    await userEvent.click(screen.getByRole('button', { name: '更新' }));
    await waitFor(() => {
      expect(mockPut).toHaveBeenCalledWith(
        '/admin/events/evt-456',
        expect.objectContaining({ name: '既存イベント' }),
      );
    });
    expect(mockPush).toHaveBeenCalledWith('/admin/events');
  });

  it('API 更新エラー時にエラーメッセージを表示すべき', async () => {
    mockGet.mockResolvedValue(mockEvent);
    mockPut.mockRejectedValue(new Error('更新に失敗しました'));
    render(<AdminEventEditPage />);
    await waitFor(() => {
      expect(screen.getByDisplayValue('既存イベント')).toBeInTheDocument();
    });
    await userEvent.click(screen.getByRole('button', { name: '更新' }));
    await waitFor(() => {
      expect(screen.getByText('更新に失敗しました')).toBeInTheDocument();
    });
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('イベント名を空にするとバリデーションエラーを表示すべき', async () => {
    mockGet.mockResolvedValue(mockEvent);
    render(<AdminEventEditPage />);
    await waitFor(() => {
      expect(screen.getByDisplayValue('既存イベント')).toBeInTheDocument();
    });
    await userEvent.clear(screen.getByDisplayValue('既存イベント'));
    await userEvent.click(screen.getByRole('button', { name: '更新' }));
    await waitFor(() => {
      expect(screen.getByText('イベント名は必須です')).toBeInTheDocument();
    });
    expect(mockPut).not.toHaveBeenCalled();
  });
});
