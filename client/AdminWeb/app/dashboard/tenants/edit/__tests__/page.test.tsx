import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRouter, useSearchParams } from 'next/navigation';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tenantApi } from '@/lib/api/tenant-api';
import { useAuth } from '@/lib/auth/auth-context';
import { submitTenantUpdate } from '@/lib/tenant-utils';
import type { Tenant } from '@/types/tenant';
import EditTenantPage from '../page';

const pushMock = vi.fn();
const getMock = vi.fn();

vi.mock('@/lib/auth/auth-context', () => ({
  useAuth: vi.fn(),
}));

vi.mock('@/lib/api/tenant-api', () => ({
  tenantApi: {
    getTenant: vi.fn(),
  },
}));

vi.mock('@/lib/tenant-utils', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/tenant-utils')>(
      '@/lib/tenant-utils',
    );
  return {
    ...actual,
    submitTenantUpdate: vi.fn(),
  };
});

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(),
  useSearchParams: vi.fn(),
}));

const mockTenant: Tenant = {
  id: 't1',
  name: 'Tenant One',
  slug: 'tenant-one',
  status: 'ACTIVE',
  tier: 'FREE',
  adminEmail: 'admin@example.com',
  region: 'ap-northeast-1',
  isolationModel: 'POOL',
  computeType: 'SERVERLESS',
  provisioningStatus: 'COMPLETED',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-02T00:00:00Z',
};

const authedSession = {
  session: {
    user: { email: 'admin@example.com', roles: [] },
    idToken: 'i',
    accessToken: 'a',
    expires: new Date(Date.now() + 60_000).toISOString(),
  },
  signIn: vi.fn(),
  signOut: vi.fn(),
  setTokens: vi.fn(),
};

describe('EditTenantPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useAuth).mockReturnValue(authedSession);
    vi.mocked(useRouter).mockReturnValue({
      push: pushMock,
    } as unknown as ReturnType<typeof useRouter>);
    vi.mocked(useSearchParams).mockReturnValue({
      get: getMock,
    } as unknown as ReturnType<typeof useSearchParams>);
  });

  it('未認証なら null', () => {
    vi.mocked(useAuth).mockReturnValue({ ...authedSession, session: null });
    const { container } = render(<EditTenantPage />);
    expect(container.firstChild).toBeNull();
  });

  it('id クエリが無いと読み込み中', async () => {
    getMock.mockReturnValue(null);
    render(<EditTenantPage />);
    expect(await screen.findByText('読み込み中...')).toBeInTheDocument();
  });

  it('既存テナントを fetch して form に反映すべき', async () => {
    getMock.mockReturnValue('t1');
    vi.mocked(tenantApi.getTenant).mockResolvedValue(mockTenant);
    render(<EditTenantPage />);
    expect(await screen.findByDisplayValue('Tenant One')).toBeInTheDocument();
    expect(screen.getByDisplayValue('admin@example.com')).toBeInTheDocument();
  });

  it('tenant が見つからない場合 /dashboard/tenants へ push すべき', async () => {
    getMock.mockReturnValue('missing');
    vi.mocked(tenantApi.getTenant).mockResolvedValue(null);
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    render(<EditTenantPage />);
    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith('/dashboard/tenants');
    });
    alertSpy.mockRestore();
  });

  it('fetch エラー時にアラートを出すべき', async () => {
    getMock.mockReturnValue('t1');
    vi.mocked(tenantApi.getTenant).mockRejectedValue(new Error('boom'));
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    render(<EditTenantPage />);
    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith('テナント情報の取得に失敗しました');
    });
    alertSpy.mockRestore();
  });

  it('submit で更新成功すると詳細ページへ遷移すべき', async () => {
    getMock.mockReturnValue('t1');
    vi.mocked(tenantApi.getTenant).mockResolvedValue(mockTenant);
    vi.mocked(submitTenantUpdate).mockImplementation(
      async (_id, _data, onSuccess) => {
        onSuccess();
        return true;
      },
    );

    const user = userEvent.setup();
    render(<EditTenantPage />);
    await screen.findByDisplayValue('Tenant One');

    await user.click(screen.getByRole('button', { name: '更新' }));

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith('/dashboard/tenants/detail?id=t1');
    });
  });

  it('submit で更新失敗するとアラートを出すべき', async () => {
    getMock.mockReturnValue('t1');
    vi.mocked(tenantApi.getTenant).mockResolvedValue(mockTenant);
    vi.mocked(submitTenantUpdate).mockImplementation(
      async (_id, _data, _onSuccess, onError) => {
        onError();
        return false;
      },
    );
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});

    const user = userEvent.setup();
    render(<EditTenantPage />);
    await screen.findByDisplayValue('Tenant One');

    await user.click(screen.getByRole('button', { name: '更新' }));

    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith('テナント更新に失敗しました');
    });
    alertSpy.mockRestore();
  });

  it('キャンセルリンクは詳細ページへ', async () => {
    getMock.mockReturnValue('t1');
    vi.mocked(tenantApi.getTenant).mockResolvedValue(mockTenant);
    render(<EditTenantPage />);
    const cancelLink = await screen.findByRole('link', { name: 'キャンセル' });
    expect(cancelLink).toHaveAttribute(
      'href',
      '/dashboard/tenants/detail?id=t1',
    );
  });

  it('name / email / tier / status 入力を変更できるべき', async () => {
    getMock.mockReturnValue('t1');
    vi.mocked(tenantApi.getTenant).mockResolvedValue(mockTenant);
    const user = userEvent.setup();
    render(<EditTenantPage />);
    const nameInput = await screen.findByDisplayValue('Tenant One');
    await user.clear(nameInput);
    await user.type(nameInput, 'Renamed');
    expect(nameInput).toHaveValue('Renamed');

    const emailInput = screen.getByDisplayValue('admin@example.com');
    await user.clear(emailInput);
    await user.type(emailInput, 'new@example.com');
    expect(emailInput).toHaveValue('new@example.com');

    const tierSelect = screen.getByLabelText('Tier');
    await user.selectOptions(tierSelect, 'PRO');
    expect(tierSelect).toHaveValue('PRO');

    const statusSelect = screen.getByLabelText('ステータス');
    await user.selectOptions(statusSelect, 'SUSPENDED');
    expect(statusSelect).toHaveValue('SUSPENDED');
  });
});
