import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AdminEventDetailPage from '../page';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  useParams: () => ({ eventId: 'evt-123' }),
}));
const mockGet = vi.fn();
const mockPut = vi.fn();
vi.mock('@/lib/api/client', () => ({
  get: (...args: unknown[]) => mockGet(...args),
  put: (...args: unknown[]) => mockPut(...args),
}));

const mockEvent = {
  id: 'evt-123',
  name: 'テストイベント 2026',
  type: 'gameday',
  status: 'draft' as const,
  startTime: '2026-04-10T09:00:00Z',
  endTime: '2026-04-10T18:00:00Z',
  timezone: 'Asia/Tokyo',
  participantType: 'team',
  cloudProvider: 'aws',
  regions: ['ap-northeast-1'],
  scoringType: 'realtime',
  leaderboardVisible: true,
  problemCount: 2,
  participantCount: 15,
  maxParticipants: 100,
  isRegistered: false,
  description: 'テストイベントの説明です',
  slug: 'test-event-2026',
  problems: [
    { id: 'p-1', title: '問題A', maxScore: 100, status: 'open' },
    { id: 'p-2', title: '問題B', maxScore: 200, status: 'open' },
  ],
};

describe('イベント詳細ページ', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ローディング中にスピナーを表示すべき', () => {
    mockGet.mockReturnValue(new Promise(() => {}));
    render(<AdminEventDetailPage />);
    expect(document.querySelector('[class*="awsui_root"]')).toBeInTheDocument();
  });

  it('API からイベントデータを取得すべき', async () => {
    mockGet.mockResolvedValue(mockEvent);
    render(<AdminEventDetailPage />);
    await waitFor(() => {
      expect(mockGet).toHaveBeenCalledWith('/admin/events/evt-123');
    });
  });

  it('イベント名がヘッダーに表示されるべき', async () => {
    mockGet.mockResolvedValue(mockEvent);
    render(<AdminEventDetailPage />);
    await waitFor(() => {
      expect(screen.getByText('テストイベント 2026')).toBeInTheDocument();
    });
  });

  it('基本情報セクションが表示されるべき', async () => {
    mockGet.mockResolvedValue(mockEvent);
    render(<AdminEventDetailPage />);
    await waitFor(() => {
      expect(screen.getByText('基本情報')).toBeInTheDocument();
    });
  });

  it('参加者数が表示されるべき', async () => {
    mockGet.mockResolvedValue(mockEvent);
    render(<AdminEventDetailPage />);
    await waitFor(() => {
      expect(screen.getByText('15 / 100')).toBeInTheDocument();
    });
  });

  it('参加形式がチームとして表示されるべき', async () => {
    mockGet.mockResolvedValue(mockEvent);
    render(<AdminEventDetailPage />);
    await waitFor(() => {
      expect(screen.getByText('チーム')).toBeInTheDocument();
    });
  });

  it('説明が表示されるべき', async () => {
    mockGet.mockResolvedValue(mockEvent);
    render(<AdminEventDetailPage />);
    await waitFor(() => {
      expect(screen.getByText('テストイベントの説明です')).toBeInTheDocument();
    });
  });

  it('問題一覧セクションが表示されるべき', async () => {
    mockGet.mockResolvedValue(mockEvent);
    render(<AdminEventDetailPage />);
    await waitFor(() => {
      expect(screen.getByText('問題一覧')).toBeInTheDocument();
    });
  });

  it('問題が表示されるべき', async () => {
    mockGet.mockResolvedValue(mockEvent);
    render(<AdminEventDetailPage />);
    await waitFor(() => {
      expect(screen.getByText('問題A')).toBeInTheDocument();
      expect(screen.getByText('問題B')).toBeInTheDocument();
    });
  });

  it('下書き状態で「公開する」ボタンが表示されるべき', async () => {
    mockGet.mockResolvedValue(mockEvent);
    render(<AdminEventDetailPage />);
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: '公開する' }),
      ).toBeInTheDocument();
    });
  });

  it('編集ボタンが表示されるべき', async () => {
    mockGet.mockResolvedValue(mockEvent);
    render(<AdminEventDetailPage />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '編集' })).toBeInTheDocument();
    });
  });

  it('編集ボタンクリック時に編集ページへ遷移すべき', async () => {
    mockGet.mockResolvedValue(mockEvent);
    render(<AdminEventDetailPage />);
    await waitFor(() => {
      expect(screen.getByText('テストイベント 2026')).toBeInTheDocument();
    });
    await userEvent.click(screen.getByRole('button', { name: '編集' }));
    expect(mockPush).toHaveBeenCalledWith('/admin/events/evt-123/edit');
  });

  it('「イベント一覧に戻る」ボタンが表示されるべき', async () => {
    mockGet.mockResolvedValue(mockEvent);
    render(<AdminEventDetailPage />);
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'イベント一覧に戻る' }),
      ).toBeInTheDocument();
    });
  });

  it('取得エラー時にエラーメッセージを表示すべき', async () => {
    mockGet.mockRejectedValue(new Error('Not Found'));
    render(<AdminEventDetailPage />);
    await waitFor(() => {
      expect(screen.getByText('Not Found')).toBeInTheDocument();
    });
  });

  it('取得エラー時に再読み込みボタンが表示されるべき', async () => {
    mockGet.mockRejectedValue(new Error('Not Found'));
    render(<AdminEventDetailPage />);
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: '再読み込み' }),
      ).toBeInTheDocument();
    });
  });

  it('Error 以外の取得エラー時もエラーメッセージを表示すべき', async () => {
    mockGet.mockRejectedValue('unknown');
    render(<AdminEventDetailPage />);
    await waitFor(() => {
      expect(
        screen.getByText('イベントの取得に失敗しました'),
      ).toBeInTheDocument();
    });
  });

  it('ステータス遷移ボタンクリック時に PUT API を呼び出すべき', async () => {
    mockGet.mockResolvedValue(mockEvent);
    mockPut.mockResolvedValue({ ...mockEvent, status: 'scheduled' });
    render(<AdminEventDetailPage />);
    await waitFor(() => {
      expect(screen.getByText('テストイベント 2026')).toBeInTheDocument();
    });
    await userEvent.click(screen.getByRole('button', { name: '公開する' }));
    await waitFor(() => {
      expect(mockPut).toHaveBeenCalledWith('/admin/events/evt-123', {
        status: 'scheduled',
      });
    });
  });

  it('予定ステータスで「開始する」と「キャンセル」ボタンが表示されるべき', async () => {
    mockGet.mockResolvedValue({ ...mockEvent, status: 'scheduled' });
    render(<AdminEventDetailPage />);
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: '開始する' }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'キャンセル' }),
      ).toBeInTheDocument();
    });
  });

  it('開催中ステータスで「一時停止」と「終了する」ボタンが表示されるべき', async () => {
    mockGet.mockResolvedValue({ ...mockEvent, status: 'active' });
    render(<AdminEventDetailPage />);
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: '一時停止' }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: '終了する' }),
      ).toBeInTheDocument();
    });
  });

  it('一時停止ステータスで「再開する」と「キャンセル」ボタンが表示されるべき', async () => {
    mockGet.mockResolvedValue({ ...mockEvent, status: 'paused' });
    render(<AdminEventDetailPage />);
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: '再開する' }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'キャンセル' }),
      ).toBeInTheDocument();
    });
  });

  it('完了ステータスで「キャンセル」ボタンのみ表示されるべき', async () => {
    mockGet.mockResolvedValue({ ...mockEvent, status: 'completed' });
    render(<AdminEventDetailPage />);
    await waitFor(() => {
      expect(screen.getByText('テストイベント 2026')).toBeInTheDocument();
    });
    expect(
      screen.getByRole('button', { name: 'キャンセル' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '公開する' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '開始する' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '終了する' }),
    ).not.toBeInTheDocument();
  });

  it('キャンセル済みステータスでは遷移ボタンが表示されないべき', async () => {
    mockGet.mockResolvedValue({ ...mockEvent, status: 'cancelled' });
    render(<AdminEventDetailPage />);
    await waitFor(() => {
      expect(screen.getByText('テストイベント 2026')).toBeInTheDocument();
    });
    expect(
      screen.queryByRole('button', { name: '公開する' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'キャンセル' }),
    ).not.toBeInTheDocument();
  });

  it('問題が空の場合に空メッセージを表示すべき', async () => {
    mockGet.mockResolvedValue({ ...mockEvent, problems: [] });
    render(<AdminEventDetailPage />);
    await waitFor(() => {
      expect(screen.getByText('問題がまだありません')).toBeInTheDocument();
    });
  });

  it('個人参加形式が正しく表示されるべき', async () => {
    mockGet.mockResolvedValue({
      ...mockEvent,
      participantType: 'individual',
    });
    render(<AdminEventDetailPage />);
    await waitFor(() => {
      expect(screen.getByText('個人')).toBeInTheDocument();
    });
  });

  it('Incident Drill タイプバッジが表示されるべき', async () => {
    mockGet.mockResolvedValue(mockEvent);
    render(<AdminEventDetailPage />);
    await waitFor(() => {
      expect(screen.getByText('Incident Drill')).toBeInTheDocument();
    });
  });

  it('Challenge タイプバッジが表示されるべき', async () => {
    mockGet.mockResolvedValue({ ...mockEvent, type: 'jam' });
    render(<AdminEventDetailPage />);
    await waitFor(() => {
      expect(screen.getByText('Challenge')).toBeInTheDocument();
    });
  });
});
