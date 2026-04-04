import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import GamedayEntryPage from '../page';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

describe('GameDay エントリーページ', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ページタイトル「GameDay」が表示されるべき', () => {
    render(<GamedayEntryPage />);
    expect(screen.getByText('GameDay')).toBeInTheDocument();
  });

  it('イベントID入力フィールドが表示されるべき', () => {
    render(<GamedayEntryPage />);
    expect(screen.getByLabelText('イベント ID')).toBeInTheDocument();
  });

  it('説明テキストが表示されるべき', () => {
    render(<GamedayEntryPage />);
    expect(
      screen.getByText('イベントIDを入力してバトルに参加します')
    ).toBeInTheDocument();
  });

  it('「参加」ボタンが表示されるべき', () => {
    render(<GamedayEntryPage />);
    expect(screen.getByRole('button', { name: '参加' })).toBeInTheDocument();
  });

  it('空入力時に「参加」ボタンが無効になるべき', () => {
    render(<GamedayEntryPage />);
    const button = screen.getByRole('button', { name: '参加' });
    expect(button).toBeDisabled();
  });

  it('イベントIDを入力すると「参加」ボタンが有効になるべき', async () => {
    const user = userEvent.setup();
    render(<GamedayEntryPage />);

    const input = screen.getByLabelText('イベント ID');
    await user.type(input, 'my-event-123');

    const button = screen.getByRole('button', { name: '参加' });
    expect(button).toBeEnabled();
  });

  it('「参加」ボタンクリックで /gameday/{eventId} に遷移すべき', async () => {
    const user = userEvent.setup();
    render(<GamedayEntryPage />);

    const input = screen.getByLabelText('イベント ID');
    await user.type(input, 'event-abc');

    const button = screen.getByRole('button', { name: '参加' });
    await user.click(button);

    expect(mockPush).toHaveBeenCalledWith('/gameday/event-abc');
  });

  it('Enter キーで /gameday/{eventId} に遷移すべき', async () => {
    const user = userEvent.setup();
    render(<GamedayEntryPage />);

    const input = screen.getByLabelText('イベント ID');
    await user.type(input, 'event-xyz{Enter}');

    expect(mockPush).toHaveBeenCalledWith('/gameday/event-xyz');
  });

  it('空白のみの入力ではボタンが無効のままであるべき', async () => {
    const user = userEvent.setup();
    render(<GamedayEntryPage />);

    const input = screen.getByLabelText('イベント ID');
    await user.type(input, '   ');

    const button = screen.getByRole('button', { name: '参加' });
    expect(button).toBeDisabled();
  });

  it('入力値の前後の空白がトリムされて遷移すべき', async () => {
    const user = userEvent.setup();
    render(<GamedayEntryPage />);

    const input = screen.getByLabelText('イベント ID');
    await user.type(input, '  trimmed-id  ');

    const button = screen.getByRole('button', { name: '参加' });
    await user.click(button);

    expect(mockPush).toHaveBeenCalledWith('/gameday/trimmed-id');
  });

  it('「はじめかた」ガイドが表示されるべき', () => {
    render(<GamedayEntryPage />);
    expect(screen.getByText('はじめかた')).toBeInTheDocument();
  });

  it('イベント一覧へのリンクが /events を指すべき', () => {
    render(<GamedayEntryPage />);
    const link = screen.getByRole('link', { name: 'イベント一覧' });
    expect(link).toHaveAttribute('href', '/events');
  });
});
