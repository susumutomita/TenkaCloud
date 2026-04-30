import { render, screen, waitFor } from '@testing-library/react';
import { useRouter, useSearchParams } from 'next/navigation';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tenantApi } from '@/lib/api/tenant-api';
import { useAuth } from '@/lib/auth/auth-context';
import type { Tenant } from '@/types/tenant';
import TenantDetailPage from '../page';

const replaceMock = vi.fn();
const getMock = vi.fn();

vi.mock('@/lib/auth/auth-context', () => ({
  useAuth: vi.fn(),
}));

vi.mock('@/lib/api/tenant-api', () => ({
  tenantApi: {
    getTenant: vi.fn(),
  },
}));

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(),
  useSearchParams: vi.fn(),
}));

vi.mock('@/components/tenants/plan-card', () => ({
  PlanCard: () => <div data-testid="plan-card" />,
}));

vi.mock('@/components/tenants/provisioning-card', () => ({
  ProvisioningCard: () => <div data-testid="provisioning-card" />,
}));

vi.mock('@/components/tenants/tenant-access-card', () => ({
  TenantAccessCard: () => <div data-testid="access-card" />,
}));

vi.mock('@/components/tenants/tenant-actions', () => ({
  TenantActions: () => <div data-testid="actions" />,
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

describe('TenantDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useAuth).mockReturnValue(authedSession);
    vi.mocked(useRouter).mockReturnValue({
      replace: replaceMock,
    } as unknown as ReturnType<typeof useRouter>);
    vi.mocked(useSearchParams).mockReturnValue({
      get: getMock,
    } as unknown as ReturnType<typeof useSearchParams>);
  });

  it('未認証なら null', () => {
    vi.mocked(useAuth).mockReturnValue({ ...authedSession, session: null });
    const { container } = render(<TenantDetailPage />);
    expect(container.firstChild).toBeNull();
  });

  it('id クエリが無いと読み込み中表示', async () => {
    getMock.mockReturnValue(null);
    render(<TenantDetailPage />);
    expect(await screen.findByText('読み込み中...')).toBeInTheDocument();
  });

  it('tenant が見つからない場合 /dashboard/tenants へ replace すべき', async () => {
    getMock.mockReturnValue('missing');
    vi.mocked(tenantApi.getTenant).mockResolvedValue(null);
    render(<TenantDetailPage />);
    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/dashboard/tenants');
    });
  });

  it('tenant 詳細を表示すべき', async () => {
    getMock.mockReturnValue('t1');
    vi.mocked(tenantApi.getTenant).mockResolvedValue(mockTenant);
    render(<TenantDetailPage />);
    expect(await screen.findByText('Tenant One')).toBeInTheDocument();
    expect(screen.getByText(/admin@example.com/)).toBeInTheDocument();
    expect(screen.getByText('tenant-one')).toBeInTheDocument();
  });

  it('SUSPENDED ステータスを表示できる', async () => {
    getMock.mockReturnValue('t1');
    vi.mocked(tenantApi.getTenant).mockResolvedValue({
      ...mockTenant,
      status: 'SUSPENDED',
    });
    render(<TenantDetailPage />);
    expect(await screen.findByText('SUSPENDED')).toBeInTheDocument();
  });

  it('ARCHIVED ステータスを表示できる', async () => {
    getMock.mockReturnValue('t1');
    vi.mocked(tenantApi.getTenant).mockResolvedValue({
      ...mockTenant,
      status: 'ARCHIVED',
    });
    render(<TenantDetailPage />);
    expect(await screen.findByText('ARCHIVED')).toBeInTheDocument();
  });

  it('編集リンクは query string 形式', async () => {
    getMock.mockReturnValue('t1');
    vi.mocked(tenantApi.getTenant).mockResolvedValue(mockTenant);
    render(<TenantDetailPage />);
    const editLink = await screen.findByRole('link', { name: '編集' });
    expect(editLink).toHaveAttribute('href', '/dashboard/tenants/edit?id=t1');
  });

  it('API エラーで tenant=null になり redirect すべき', async () => {
    getMock.mockReturnValue('t1');
    vi.mocked(tenantApi.getTenant).mockRejectedValue(new Error('boom'));
    render(<TenantDetailPage />);
    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/dashboard/tenants');
    });
  });
});
