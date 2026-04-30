import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tenantApi } from '@/lib/api/tenant-api';
import { useAuth } from '@/lib/auth/auth-context';
import { getStatusVariant } from '@/lib/tenant-utils';
import type { Tenant } from '@/types/tenant';
import TenantsPage from '../page';

vi.mock('@/lib/auth/auth-context', () => ({
  useAuth: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

vi.mock('@/lib/api/tenant-api', () => ({
  tenantApi: {
    listTenants: vi.fn(),
    deleteTenant: vi.fn().mockResolvedValue(true),
  },
}));

vi.mock('@cloudscape-design/components/box', () => ({
  default: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock('@cloudscape-design/components/button', () => ({
  default: ({ children }: { children?: React.ReactNode }) => (
    <button type="button">{children}</button>
  ),
}));

vi.mock('@cloudscape-design/components/column-layout', () => ({
  default: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock('@cloudscape-design/components/container', () => ({
  default: ({
    children,
    header,
  }: {
    children?: React.ReactNode;
    header?: React.ReactNode;
  }) => (
    <div>
      {header}
      {children}
    </div>
  ),
}));

vi.mock('@cloudscape-design/components/header', () => ({
  default: ({
    children,
    description,
    actions,
  }: {
    children?: React.ReactNode;
    description?: React.ReactNode;
    actions?: React.ReactNode;
  }) => (
    <div>
      {children}
      {description ? <p>{description}</p> : null}
      {actions}
    </div>
  ),
}));

vi.mock('@cloudscape-design/components/space-between', () => ({
  default: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock('@cloudscape-design/components/modal', () => ({
  default: ({
    visible,
    children,
    header,
    footer,
  }: {
    visible: boolean;
    children?: React.ReactNode;
    header?: React.ReactNode;
    footer?: React.ReactNode;
  }) =>
    visible ? (
      <div role="dialog">
        <div>{header}</div>
        <div>{children}</div>
        <div>{footer}</div>
      </div>
    ) : null,
}));

vi.mock('@cloudscape-design/global-styles/index.css', () => ({}));

const mockTenants: Tenant[] = [
  {
    id: '1',
    name: 'テナント1',
    slug: 'tenant-1',
    status: 'ACTIVE',
    tier: 'FREE',
    adminEmail: 'admin1@example.com',
    region: 'ap-northeast-1',
    isolationModel: 'POOL',
    computeType: 'SERVERLESS',
    provisioningStatus: 'COMPLETED',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  },
  {
    id: '2',
    name: 'テナント2',
    slug: 'tenant-2',
    status: 'SUSPENDED',
    tier: 'PRO',
    adminEmail: 'admin2@example.com',
    region: 'ap-northeast-1',
    isolationModel: 'POOL',
    computeType: 'SERVERLESS',
    provisioningStatus: 'COMPLETED',
    createdAt: '2024-01-02T00:00:00Z',
    updatedAt: '2024-01-02T00:00:00Z',
  },
  {
    id: '3',
    name: 'テナント3',
    slug: 'tenant-3',
    status: 'ARCHIVED',
    tier: 'ENTERPRISE',
    adminEmail: 'admin3@example.com',
    region: 'ap-northeast-1',
    isolationModel: 'SILO',
    computeType: 'KUBERNETES',
    provisioningStatus: 'COMPLETED',
    createdAt: '2024-01-03T00:00:00Z',
    updatedAt: '2024-01-03T00:00:00Z',
  },
];

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

describe('TenantsPage コンポーネント', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useAuth).mockReturnValue(authedSession);
  });

  describe('未認証時', () => {
    it('session が無いと何もレンダリングしないべき', () => {
      vi.mocked(useAuth).mockReturnValue({
        ...authedSession,
        session: null,
      });
      const { container } = render(<TenantsPage />);
      expect(container.firstChild).toBeNull();
    });
  });

  describe('ヘッダーセクション', () => {
    it('タイトルを表示すべき', async () => {
      vi.mocked(tenantApi.listTenants).mockResolvedValue([]);
      render(<TenantsPage />);
      expect(await screen.findByText('テナント管理')).toBeInTheDocument();
    });

    it('説明文を表示すべき', async () => {
      vi.mocked(tenantApi.listTenants).mockResolvedValue([]);
      render(<TenantsPage />);
      expect(
        await screen.findByText('テナントの作成・管理を行います。'),
      ).toBeInTheDocument();
    });

    it('新規テナント作成ボタンを表示すべき', async () => {
      vi.mocked(tenantApi.listTenants).mockResolvedValue([]);
      render(<TenantsPage />);
      const link = await screen.findByRole('link', {
        name: '新規テナントを作成',
      });
      expect(link).toHaveAttribute('href', '/dashboard/tenants/new');
    });
  });

  describe('統計カード', () => {
    it('テナント統計を表示すべき', async () => {
      vi.mocked(tenantApi.listTenants).mockResolvedValue(mockTenants);
      render(<TenantsPage />);
      await waitFor(() => {
        expect(screen.getByText('総テナント')).toBeInTheDocument();
      });
      expect(screen.getByText('稼働中')).toBeInTheDocument();
      expect(screen.getByText('一時停止')).toBeInTheDocument();
      expect(screen.getAllByText('Enterprise').length).toBeGreaterThanOrEqual(
        1,
      );
    });
  });

  describe('テナントが0件の場合', () => {
    it('空状態メッセージを表示すべき', async () => {
      vi.mocked(tenantApi.listTenants).mockResolvedValue([]);
      render(<TenantsPage />);
      expect(
        await screen.findByText('テナントがまだ登録されていません'),
      ).toBeInTheDocument();
    });

    it('最初のテナント作成ボタンを表示すべき', async () => {
      vi.mocked(tenantApi.listTenants).mockResolvedValue([]);
      render(<TenantsPage />);
      expect(
        await screen.findByRole('link', { name: '最初のテナントを作成' }),
      ).toBeInTheDocument();
    });
  });

  describe('テナントがある場合', () => {
    it('テナントテーブルを表示すべき', async () => {
      vi.mocked(tenantApi.listTenants).mockResolvedValue(mockTenants);
      render(<TenantsPage />);
      expect(await screen.findByText('テナント1')).toBeInTheDocument();
      expect(screen.getByText('テナント2')).toBeInTheDocument();
      expect(screen.getByText('テナント3')).toBeInTheDocument();
    });

    it('テナント詳細リンクが query string 形式になるべき', async () => {
      vi.mocked(tenantApi.listTenants).mockResolvedValue(mockTenants);
      render(<TenantsPage />);
      await waitFor(() => {
        expect(screen.getAllByRole('link', { name: '詳細' })).toHaveLength(3);
      });
      const detailLinks = screen.getAllByRole('link', { name: '詳細' });
      expect(detailLinks[0]).toHaveAttribute(
        'href',
        '/dashboard/tenants/detail?id=1',
      );
    });

    it('テナント編集リンクが query string 形式になるべき', async () => {
      vi.mocked(tenantApi.listTenants).mockResolvedValue(mockTenants);
      render(<TenantsPage />);
      await waitFor(() => {
        expect(screen.getAllByRole('link', { name: '編集' })).toHaveLength(3);
      });
      const editLinks = screen.getAllByRole('link', { name: '編集' });
      expect(editLinks[0]).toHaveAttribute(
        'href',
        '/dashboard/tenants/edit?id=1',
      );
    });
  });

  describe('API エラー時', () => {
    it('リストが空のままレンダリングされるべき', async () => {
      vi.mocked(tenantApi.listTenants).mockRejectedValue(new Error('boom'));
      render(<TenantsPage />);
      expect(
        await screen.findByText('テナントがまだ登録されていません'),
      ).toBeInTheDocument();
    });
  });
});

describe('getStatusVariant 関数', () => {
  it('ACTIVE の場合は success を返すべき', () => {
    expect(getStatusVariant('ACTIVE')).toBe('success');
  });

  it('SUSPENDED の場合は warning を返すべき', () => {
    expect(getStatusVariant('SUSPENDED')).toBe('warning');
  });

  it('その他の場合は error を返すべき', () => {
    expect(getStatusVariant('ARCHIVED')).toBe('error');
    expect(getStatusVariant('UNKNOWN')).toBe('error');
  });
});
