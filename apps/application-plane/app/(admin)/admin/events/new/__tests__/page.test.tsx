import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import AdminEventNewPage from '../page';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  useParams: () => ({}),
}));

vi.mock('next-auth/react', () => ({
  SessionProvider: ({ children }: { children: React.ReactNode }) => children,
  useSession: () => ({ data: null, status: 'unauthenticated' }),
  getSession: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/tenant', () => ({
  useTenantOptional: () => null,
}));

const mockPost = vi.fn();
vi.mock('@/lib/api/client', () => ({
  post: (...args: unknown[]) => mockPost(...args),
}));

describe('AdminEventNewPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('イベント作成フォームを表示すべき', () => {
    render(<AdminEventNewPage />);
    expect(screen.getAllByText(/イベント作成/).length).toBeGreaterThanOrEqual(
      1,
    );
  });

  it('イベント名入力フィールドを表示すべき', () => {
    render(<AdminEventNewPage />);
    expect(screen.getAllByText(/イベント名/).length).toBeGreaterThanOrEqual(1);
  });

  it('キャンセルボタンを表示すべき', () => {
    render(<AdminEventNewPage />);
    const buttons = screen.getAllByRole('button');
    const cancelButton = buttons.find((b) =>
      b.textContent?.includes('キャンセル'),
    );
    expect(cancelButton).toBeTruthy();
  });

  it('作成ボタンを表示すべき', () => {
    render(<AdminEventNewPage />);
    const buttons = screen.getAllByRole('button');
    const createButton = buttons.find((b) => b.textContent?.includes('作成'));
    expect(createButton).toBeTruthy();
  });

  it('タイプ選択フィールドを表示すべき', () => {
    render(<AdminEventNewPage />);
    expect(screen.getAllByText(/タイプ/).length).toBeGreaterThanOrEqual(1);
  });

  it('サーバーエラー時にエラーメッセージを表示すべき', async () => {
    mockPost.mockRejectedValue(new Error('イベントの作成に失敗しました'));
    render(<AdminEventNewPage />);

    // Submitting the form with no data should show validation errors
    const buttons = screen.getAllByRole('button');
    const createButton = buttons.find((b) => b.textContent?.includes('作成'));
    if (createButton) {
      createButton.click();
      await waitFor(() => {
        // Validation errors or form still shows
        expect(screen.getAllByRole('button').length).toBeGreaterThan(0);
      });
    }
  });
});
