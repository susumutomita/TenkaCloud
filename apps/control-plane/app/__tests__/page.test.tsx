import { redirect } from 'next/navigation';
import type { Session } from 'next-auth';
import type { Mock } from 'vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { auth } from '@/auth';
import HomePage from '../page';

// auth のモック
vi.mock('@/auth', () => ({
  auth: vi.fn(),
}));

// next/navigation のモック
vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
}));

// auth を正しい型でモック
const mockedAuth = auth as unknown as Mock<() => Promise<Session | null>>;

describe('HomePage コンポーネント', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('認証済みユーザーは /dashboard へリダイレクトされるべき', async () => {
    mockedAuth.mockResolvedValue({
      user: { name: 'Test User', email: 'test@example.com' },
      expires: '',
    });

    await HomePage();

    expect(redirect).toHaveBeenCalledWith('/dashboard');
  });

  it('未認証ユーザーは /login へリダイレクトされるべき', async () => {
    mockedAuth.mockResolvedValue(null);

    await HomePage();

    expect(redirect).toHaveBeenCalledWith('/login');
  });

  it('session が存在するが user がない場合は /login へリダイレクトされるべき', async () => {
    mockedAuth.mockResolvedValue({
      user: undefined as unknown as Session['user'],
      expires: '',
    });

    await HomePage();

    expect(redirect).toHaveBeenCalledWith('/login');
  });
});
