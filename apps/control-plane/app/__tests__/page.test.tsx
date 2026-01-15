import { redirect } from 'next/navigation';
import type { Session } from 'next-auth';
import type { Mock } from 'vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getSession } from '@/auth';
import HomePage from '../page';

// getSession のモック
vi.mock('@/auth', () => ({
  getSession: vi.fn(),
}));

// next/navigation のモック
vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
}));

// getSession を正しい型でモック
const mockedGetSession = getSession as unknown as Mock<
  () => Promise<Session | null>
>;

describe('HomePage コンポーネント', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('認証済みユーザーは /dashboard へリダイレクトされるべき', async () => {
    mockedGetSession.mockResolvedValue({
      user: { name: 'Test User', email: 'test@example.com' },
      expires: '',
    });

    await HomePage();

    expect(redirect).toHaveBeenCalledWith('/dashboard');
  });

  it('未認証ユーザーは /login へリダイレクトされるべき', async () => {
    mockedGetSession.mockResolvedValue(null);

    await HomePage();

    expect(redirect).toHaveBeenCalledWith('/login');
  });

  it('session が存在するが user がない場合は /login へリダイレクトされるべき', async () => {
    mockedGetSession.mockResolvedValue({
      user: undefined as unknown as Session['user'],
      expires: '',
    });

    await HomePage();

    expect(redirect).toHaveBeenCalledWith('/login');
  });
});
