import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import AdminEventDetailPage from '../page';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  useParams: () => ({ eventId: 'event-1' }),
}));

const mockGet = vi.fn();
const mockPatch = vi.fn();
vi.mock('@/lib/api/client', () => ({
  get: (...args: unknown[]) => mockGet(...args),
  patch: (...args: unknown[]) => mockPatch(...args),
  post: vi.fn(),
}));

const baseEvent = {
  id: 'event-1',
  name: '\u30c6\u30b9\u30c8\u30a4\u30d9\u30f3\u30c8',
  description: '\u30c6\u30b9\u30c8\u8aac\u660e',
  status: 'draft' as const,
  type: 'gameday' as const,
  startTime: '2026-05-01T09:00:00Z',
  endTime: '2026-05-01T18:00:00Z',
  participantCount: 10,
  maxParticipants: 100,
  cloudProvider: 'aws' as const,
  participantType: 'team' as const,
  problems: [
    { id: 'prob-1', title: '\u554f\u984c1', points: 100, solvedCount: 5 },
    { id: 'prob-2', title: '\u554f\u984c2', points: 200, solvedCount: 3 },
  ],
};

function getTabButton(name: string) {
  const buttons = screen.getAllByRole('button');
  const tab = buttons.find(
    (btn) => btn.textContent === name && btn.classList.contains('border-b-2'),
  );
  if (!tab) throw new Error(`Tab button "${name}" not found`);
  return tab;
}

describe('Admin \u30a4\u30d9\u30f3\u30c8\u8a73\u7d30\u30da\u30fc\u30b8', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('\u30a4\u30d9\u30f3\u30c8\u8a73\u7d30\u3092 API \u304b\u3089\u53d6\u5f97\u3057\u3066\u8868\u793a\u3059\u3079\u304d', async () => {
    mockGet.mockResolvedValue(baseEvent);
    render(<AdminEventDetailPage />);

    await waitFor(() => {
      expect(
        screen.getByText('\u30c6\u30b9\u30c8\u8aac\u660e'),
      ).toBeInTheDocument();
    });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      '\u30c6\u30b9\u30c8\u30a4\u30d9\u30f3\u30c8',
    );
    expect(mockGet).toHaveBeenCalledWith('/admin/events/event-1');
  });

  it('\u30ed\u30fc\u30c7\u30a3\u30f3\u30b0\u4e2d\u306f\u30b9\u30b1\u30eb\u30c8\u30f3\u3092\u8868\u793a\u3059\u3079\u304d', () => {
    mockGet.mockReturnValue(new Promise(() => {}));
    const { container } = render(<AdminEventDetailPage />);

    const skeletons = container.querySelectorAll('[class*="animate-pulse"]');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it('API \u30a8\u30e9\u30fc\u6642\u306f\u30a8\u30e9\u30fc\u30e1\u30c3\u30bb\u30fc\u30b8\u3092\u8868\u793a\u3059\u3079\u304d', async () => {
    mockGet.mockRejectedValue(new Error('Network error'));
    render(<AdminEventDetailPage />);

    await waitFor(() => {
      expect(screen.getByText('\u518d\u8a66\u884c')).toBeInTheDocument();
    });
  });

  it('\u4e0b\u66f8\u304d\u30a4\u30d9\u30f3\u30c8\u306e\u5834\u5408\u306f\u516c\u958b\u30dc\u30bf\u30f3\u3092\u8868\u793a\u3059\u3079\u304d', async () => {
    mockGet.mockResolvedValue(baseEvent);
    render(<AdminEventDetailPage />);

    await waitFor(() => {
      expect(screen.getByText('\u516c\u958b\u3059\u308b')).toBeInTheDocument();
    });
  });

  it('\u516c\u958b\u6e08\u307f\u30a4\u30d9\u30f3\u30c8\u306e\u5834\u5408\u306f\u516c\u958b\u30dc\u30bf\u30f3\u3092\u975e\u8868\u793a\u306b\u3059\u3079\u304d', async () => {
    mockGet.mockResolvedValue({ ...baseEvent, status: 'published' });
    render(<AdminEventDetailPage />);

    await waitFor(() => {
      expect(
        screen.getByText('\u30c6\u30b9\u30c8\u8aac\u660e'),
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByText('\u516c\u958b\u3059\u308b'),
    ).not.toBeInTheDocument();
  });

  it('\u516c\u958b\u30dc\u30bf\u30f3\u3092\u30af\u30ea\u30c3\u30af\u3059\u308b\u3068\u30b9\u30c6\u30fc\u30bf\u30b9\u5909\u66f4 API \u3092\u547c\u3073\u51fa\u3059\u3079\u304d', async () => {
    mockGet.mockResolvedValue(baseEvent);
    mockPatch.mockResolvedValue({ ...baseEvent, status: 'published' });
    render(<AdminEventDetailPage />);

    await waitFor(() => {
      expect(screen.getByText('\u516c\u958b\u3059\u308b')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('\u516c\u958b\u3059\u308b'));

    await waitFor(() => {
      expect(mockPatch).toHaveBeenCalledWith('/admin/events/event-1', {
        status: 'published',
      });
    });
  });

  it('\u7de8\u96c6\u30dc\u30bf\u30f3\u3092\u30af\u30ea\u30c3\u30af\u3059\u308b\u3068\u7de8\u96c6\u30da\u30fc\u30b8\u306b\u9077\u79fb\u3059\u3079\u304d', async () => {
    mockGet.mockResolvedValue(baseEvent);
    render(<AdminEventDetailPage />);

    await waitFor(() => {
      expect(
        screen.getByText('\u30c6\u30b9\u30c8\u8aac\u660e'),
      ).toBeInTheDocument();
    });

    // Header edit button
    const headerButtons = screen
      .getAllByText('\u7de8\u96c6')
      .filter((el) => el.tagName === 'BUTTON' || el.closest('button'));
    fireEvent.click(headerButtons[0]);

    expect(mockPush).toHaveBeenCalledWith('/admin/events/event-1/edit');
  });

  it('\u554f\u984c\u30bf\u30d6\u3067\u554f\u984c\u4e00\u89a7\u3092\u8868\u793a\u3059\u3079\u304d', async () => {
    mockGet.mockResolvedValue(baseEvent);
    render(<AdminEventDetailPage />);

    await waitFor(() => {
      expect(
        screen.getByText('\u30c6\u30b9\u30c8\u8aac\u660e'),
      ).toBeInTheDocument();
    });

    fireEvent.click(getTabButton('\u554f\u984c'));

    expect(screen.getByText('\u554f\u984c1')).toBeInTheDocument();
    expect(screen.getByText('\u554f\u984c2')).toBeInTheDocument();
    expect(screen.getByText('100 pts')).toBeInTheDocument();
    expect(screen.getByText('200 pts')).toBeInTheDocument();
  });

  it('\u554f\u984c\u306e\u7de8\u96c6\u30dc\u30bf\u30f3\u3092\u30af\u30ea\u30c3\u30af\u3059\u308b\u3068\u554f\u984c\u7de8\u96c6\u30da\u30fc\u30b8\u306b\u9077\u79fb\u3059\u3079\u304d', async () => {
    mockGet.mockResolvedValue(baseEvent);
    render(<AdminEventDetailPage />);

    await waitFor(() => {
      expect(
        screen.getByText('\u30c6\u30b9\u30c8\u8aac\u660e'),
      ).toBeInTheDocument();
    });

    fireEvent.click(getTabButton('\u554f\u984c'));

    const editButtons = screen.getAllByText('\u7de8\u96c6');
    // First "\u7de8\u96c6" is the header edit button, rest are per-problem
    fireEvent.click(editButtons[1]);

    expect(mockPush).toHaveBeenCalledWith('/admin/problems/prob-1/edit');
  });

  it('\u554f\u984c\u8ffd\u52a0\u30dc\u30bf\u30f3\u3092\u30af\u30ea\u30c3\u30af\u3059\u308b\u3068\u554f\u984c\u4f5c\u6210\u30da\u30fc\u30b8\u306b\u9077\u79fb\u3059\u3079\u304d', async () => {
    mockGet.mockResolvedValue(baseEvent);
    render(<AdminEventDetailPage />);

    await waitFor(() => {
      expect(
        screen.getByText('\u30c6\u30b9\u30c8\u8aac\u660e'),
      ).toBeInTheDocument();
    });

    fireEvent.click(getTabButton('\u554f\u984c'));

    fireEvent.click(screen.getByText('\u554f\u984c\u3092\u8ffd\u52a0'));

    expect(mockPush).toHaveBeenCalledWith(
      '/admin/problems/new?eventId=event-1',
    );
  });

  it('\u53c2\u52a0\u8005\u30bf\u30d6\u3067\u53c2\u52a0\u8005\u6570\u3092\u8868\u793a\u3059\u3079\u304d', async () => {
    mockGet.mockResolvedValue(baseEvent);
    render(<AdminEventDetailPage />);

    await waitFor(() => {
      expect(
        screen.getByText('\u30c6\u30b9\u30c8\u8aac\u660e'),
      ).toBeInTheDocument();
    });

    fireEvent.click(getTabButton('\u53c2\u52a0\u8005'));

    expect(
      screen.getByText(
        '10 \u4eba\u304c\u53c2\u52a0\u3057\u3066\u3044\u307e\u3059',
      ),
    ).toBeInTheDocument();
  });

  it('\u53c2\u52a0\u8005\u4e00\u89a7\u30dc\u30bf\u30f3\u3092\u30af\u30ea\u30c3\u30af\u3059\u308b\u3068\u53c2\u52a0\u8005\u30da\u30fc\u30b8\u306b\u9077\u79fb\u3059\u3079\u304d', async () => {
    mockGet.mockResolvedValue(baseEvent);
    render(<AdminEventDetailPage />);

    await waitFor(() => {
      expect(
        screen.getByText('\u30c6\u30b9\u30c8\u8aac\u660e'),
      ).toBeInTheDocument();
    });

    fireEvent.click(getTabButton('\u53c2\u52a0\u8005'));
    fireEvent.click(
      screen.getByText('\u53c2\u52a0\u8005\u4e00\u89a7\u3092\u898b\u308b'),
    );

    expect(mockPush).toHaveBeenCalledWith(
      '/admin/participants?eventId=event-1',
    );
  });

  it('\u6982\u8981\u30bf\u30d6\u3067\u30af\u30e9\u30a6\u30c9\u30d7\u30ed\u30d0\u30a4\u30c0\u30fc\u3092\u8868\u793a\u3059\u3079\u304d', async () => {
    mockGet.mockResolvedValue(baseEvent);
    render(<AdminEventDetailPage />);

    await waitFor(() => {
      expect(
        screen.getByText('\u30c6\u30b9\u30c8\u8aac\u660e'),
      ).toBeInTheDocument();
    });
    expect(screen.getByText('aws')).toBeInTheDocument();
  });

  it('\u6982\u8981\u30bf\u30d6\u3067\u53c2\u52a0\u5f62\u5f0f\u3092\u8868\u793a\u3059\u3079\u304d', async () => {
    mockGet.mockResolvedValue(baseEvent);
    render(<AdminEventDetailPage />);

    await waitFor(() => {
      expect(
        screen.getByText('\u30c1\u30fc\u30e0\u53c2\u52a0'),
      ).toBeInTheDocument();
    });
  });

  it('\u500b\u4eba\u53c2\u52a0\u306e\u5834\u5408\u306f\u300c\u500b\u4eba\u53c2\u52a0\u300d\u3068\u8868\u793a\u3059\u3079\u304d', async () => {
    mockGet.mockResolvedValue({
      ...baseEvent,
      participantType: 'individual',
    });
    render(<AdminEventDetailPage />);

    await waitFor(() => {
      expect(screen.getByText('\u500b\u4eba\u53c2\u52a0')).toBeInTheDocument();
    });
  });

  it('\u30a4\u30d9\u30f3\u30c8\u304c\u898b\u3064\u304b\u3089\u306a\u3044\u5834\u5408\u306f\u7a7a\u72b6\u614b\u3092\u8868\u793a\u3059\u3079\u304d', async () => {
    mockGet.mockResolvedValue(null);
    render(<AdminEventDetailPage />);

    await waitFor(() => {
      expect(
        screen.getByText(
          '\u30a4\u30d9\u30f3\u30c8\u304c\u898b\u3064\u304b\u308a\u307e\u305b\u3093',
        ),
      ).toBeInTheDocument();
    });
  });

  it('\u516c\u958b\u51e6\u7406\u4e2d\u306f\u30dc\u30bf\u30f3\u3092\u7121\u52b9\u306b\u3059\u3079\u304d', async () => {
    mockGet.mockResolvedValue(baseEvent);
    mockPatch.mockReturnValue(new Promise(() => {}));
    render(<AdminEventDetailPage />);

    await waitFor(() => {
      expect(screen.getByText('\u516c\u958b\u3059\u308b')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('\u516c\u958b\u3059\u308b'));

    await waitFor(() => {
      expect(screen.getByText('\u516c\u958b\u4e2d...')).toBeInTheDocument();
    });
  });

  it('\u554f\u984c\u304c\u7a7a\u306e\u5834\u5408\u306f\u7a7a\u72b6\u614b\u30e1\u30c3\u30bb\u30fc\u30b8\u3092\u8868\u793a\u3059\u3079\u304d', async () => {
    mockGet.mockResolvedValue({ ...baseEvent, problems: [] });
    render(<AdminEventDetailPage />);

    await waitFor(() => {
      expect(
        screen.getByText('\u30c6\u30b9\u30c8\u8aac\u660e'),
      ).toBeInTheDocument();
    });

    fireEvent.click(getTabButton('\u554f\u984c'));

    expect(
      screen.getByText(
        '\u554f\u984c\u304c\u307e\u3060\u3042\u308a\u307e\u305b\u3093',
      ),
    ).toBeInTheDocument();
  });
});
