import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AwsConsoleButton } from '../aws-console-button';

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock window.open
const mockWindowOpen = vi.fn();
Object.defineProperty(window, 'open', {
  value: mockWindowOpen,
  writable: true,
});

describe('AwsConsoleButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ボタンが表示されるべき', () => {
    render(<AwsConsoleButton eventId="evt-1" />);
    expect(
      screen.getByRole('button', { name: /AWS Console を開く/i })
    ).toBeInTheDocument();
  });

  it('カスタムラベルを表示すべき', () => {
    render(<AwsConsoleButton eventId="evt-1" label="カスタムラベル" />);
    expect(
      screen.getByRole('button', { name: /カスタムラベル/i })
    ).toBeInTheDocument();
  });

  it('クリック時に Federation URL を取得して新しいタブで開くべき', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          url: 'https://signin.aws.amazon.com/federation?Action=login&SigninToken=test',
          expiresAt: new Date().toISOString(),
        }),
    });

    render(<AwsConsoleButton eventId="evt-1" />);
    const button = screen.getByRole('button', { name: /AWS Console を開く/i });
    await user.click(button);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/participant/events/evt-1/aws-console'
      );
    });

    await waitFor(() => {
      expect(mockWindowOpen).toHaveBeenCalledWith(
        'https://signin.aws.amazon.com/federation?Action=login&SigninToken=test',
        '_blank',
        'noopener,noreferrer'
      );
    });
  });

  it('API エラー時にエラーメッセージを表示すべき', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValue({
      ok: false,
      json: () =>
        Promise.resolve({
          error: 'AWS Console access is not configured for this event',
        }),
    });

    render(<AwsConsoleButton eventId="evt-1" />);
    const button = screen.getByRole('button', { name: /AWS Console を開く/i });
    await user.click(button);

    await waitFor(() => {
      expect(
        screen.getByText('AWS Console access is not configured for this event')
      ).toBeInTheDocument();
    });
  });

  it('ネットワークエラー時にフォールバックメッセージを表示すべき', async () => {
    const user = userEvent.setup();
    mockFetch.mockRejectedValue(new Error('Network error'));

    render(<AwsConsoleButton eventId="evt-1" />);
    const button = screen.getByRole('button', { name: /AWS Console を開く/i });
    await user.click(button);

    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeInTheDocument();
    });
  });

  it('eventId を URL エンコードすべき', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          url: 'https://signin.aws.amazon.com/federation?Action=login',
          expiresAt: new Date().toISOString(),
        }),
    });

    render(<AwsConsoleButton eventId="event with spaces" />);
    const button = screen.getByRole('button', { name: /AWS Console を開く/i });
    await user.click(button);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/participant/events/event%20with%20spaces/aws-console'
      );
    });
  });
});
