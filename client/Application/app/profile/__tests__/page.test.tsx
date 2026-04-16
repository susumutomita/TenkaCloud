import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import ProfilePage from '../page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useParams: () => ({}),
}));

vi.mock('next-auth/react', () => ({
  SessionProvider: ({ children }: { children: React.ReactNode }) => children,
  useSession: () => ({ data: null, status: 'unauthenticated' }),
  getSession: vi.fn().mockResolvedValue(null),
}));

const mockGetMyProfile = vi.fn();
const mockUpdateProfile = vi.fn();
vi.mock('@/lib/api/profile', () => ({
  getMyProfile: (...args: unknown[]) => mockGetMyProfile(...args),
  updateProfile: (...args: unknown[]) => mockUpdateProfile(...args),
}));

const baseProfile = {
  id: 'user-1',
  name: 'Test User',
  email: 'test@example.com',
  totalEventsParticipated: 5,
  totalScore: 1500,
  rank: 3,
  badges: [],
  recentEvents: [],
};

function findButtonByText(text: string) {
  const buttons = screen.getAllByRole('button');
  const btn = buttons.find((b) => b.textContent?.includes(text));
  if (!btn) throw new Error(`Button with text "${text}" not found`);
  return btn;
}

describe('Profile page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('API からプロフィール情報を取得して表示すべき', async () => {
    mockGetMyProfile.mockResolvedValue(baseProfile);
    render(<ProfilePage />);

    await waitFor(() => {
      expect(screen.getByText('Test User')).toBeInTheDocument();
    });
    expect(screen.getByText('test@example.com')).toBeInTheDocument();
  });

  it('ローディング中はスピナーを表示すべき', () => {
    mockGetMyProfile.mockReturnValue(new Promise(() => {}));
    const { container } = render(<ProfilePage />);

    const spinners = container.querySelectorAll('[class*="awsui_root"]');
    expect(spinners.length).toBeGreaterThan(0);
  });

  it('API エラー時はエラーメッセージを表示すべき', async () => {
    mockGetMyProfile.mockRejectedValue(new Error('Load failed'));
    render(<ProfilePage />);

    await waitFor(() => {
      expect(screen.getByText('Load failed')).toBeInTheDocument();
    });
  });

  it('Edit ボタンをクリックすると編集フォームを表示すべき', async () => {
    mockGetMyProfile.mockResolvedValue(baseProfile);
    render(<ProfilePage />);

    await waitFor(() => {
      expect(screen.getByText('Test User')).toBeInTheDocument();
    });

    fireEvent.click(findButtonByText('Edit'));

    await waitFor(() => {
      expect(screen.getByDisplayValue('Test User')).toBeInTheDocument();
    });
  });

  it('Cancel ボタンをクリックすると表示モードに戻るべき', async () => {
    mockGetMyProfile.mockResolvedValue(baseProfile);
    render(<ProfilePage />);

    await waitFor(() => {
      expect(screen.getByText('Test User')).toBeInTheDocument();
    });

    fireEvent.click(findButtonByText('Edit'));

    await waitFor(() => {
      expect(screen.getByDisplayValue('Test User')).toBeInTheDocument();
    });

    fireEvent.click(findButtonByText('Cancel'));

    await waitFor(() => {
      expect(screen.queryByDisplayValue('Test User')).not.toBeInTheDocument();
    });
  });

  it('Save ボタンをクリックするとプロフィール更新 API を呼び出すべき', async () => {
    mockGetMyProfile.mockResolvedValue(baseProfile);
    mockUpdateProfile.mockResolvedValue({
      ...baseProfile,
      name: 'New Name',
    });
    render(<ProfilePage />);

    await waitFor(() => {
      expect(screen.getByText('Test User')).toBeInTheDocument();
    });

    fireEvent.click(findButtonByText('Edit'));

    await waitFor(() => {
      expect(screen.getByDisplayValue('Test User')).toBeInTheDocument();
    });

    const input = screen.getByDisplayValue('Test User');
    fireEvent.change(input, { target: { value: 'New Name' } });
    fireEvent.click(findButtonByText('Save'));

    await waitFor(() => {
      expect(mockUpdateProfile).toHaveBeenCalledWith({ name: 'New Name' });
    });
  });

  it('名前が空の場合はバリデーションエラーを表示すべき', async () => {
    mockGetMyProfile.mockResolvedValue(baseProfile);
    render(<ProfilePage />);

    await waitFor(() => {
      expect(screen.getByText('Test User')).toBeInTheDocument();
    });

    fireEvent.click(findButtonByText('Edit'));

    await waitFor(() => {
      expect(screen.getByDisplayValue('Test User')).toBeInTheDocument();
    });

    const input = screen.getByDisplayValue('Test User');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.click(findButtonByText('Save'));

    await waitFor(() => {
      expect(screen.getByText('Display name is required')).toBeInTheDocument();
    });
    expect(mockUpdateProfile).not.toHaveBeenCalled();
  });

  it('保存成功後は表示モードに戻るべき', async () => {
    mockGetMyProfile.mockResolvedValue(baseProfile);
    mockUpdateProfile.mockResolvedValue({
      ...baseProfile,
      name: 'New Name',
    });
    render(<ProfilePage />);

    await waitFor(() => {
      expect(screen.getByText('Test User')).toBeInTheDocument();
    });

    fireEvent.click(findButtonByText('Edit'));

    await waitFor(() => {
      expect(screen.getByDisplayValue('Test User')).toBeInTheDocument();
    });

    const input = screen.getByDisplayValue('Test User');
    fireEvent.change(input, { target: { value: 'New Name' } });
    fireEvent.click(findButtonByText('Save'));

    await waitFor(() => {
      expect(screen.getByText('New Name')).toBeInTheDocument();
    });
    expect(screen.queryByDisplayValue('New Name')).not.toBeInTheDocument();
  });

  it('プロフィールが null の場合はデフォルト名を表示すべき', async () => {
    mockGetMyProfile.mockResolvedValue(null);
    render(<ProfilePage />);

    await waitFor(() => {
      expect(screen.getByText('\u30e6\u30fc\u30b6\u30fc')).toBeInTheDocument();
    });
  });

  it('メニューリンクを表示すべき', async () => {
    mockGetMyProfile.mockResolvedValue(baseProfile);
    render(<ProfilePage />);

    await waitFor(() => {
      expect(screen.getByText('Test User')).toBeInTheDocument();
    });
    expect(screen.getByText('History')).toBeInTheDocument();
    expect(screen.getByText('Badges')).toBeInTheDocument();
  });
});
