import type {
  CreateTenantInput,
  Tenant,
  UpdateTenantInput,
} from '@/types/tenant';

const MOCK_TENANTS: Tenant[] = [
  {
    id: '1',
    name: 'Acme Corp',
    slug: 'acme-corp',
    status: 'ACTIVE',
    tier: 'ENTERPRISE',
    adminEmail: 'admin@acme.com',
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
  },
  {
    id: '2',
    name: 'Beta Inc',
    slug: 'beta-inc',
    status: 'SUSPENDED',
    tier: 'PRO',
    adminEmail: 'admin@beta.com',
    createdAt: '2025-02-01T00:00:00Z',
    updatedAt: '2025-02-10T00:00:00Z',
  },
  {
    id: '3',
    name: 'Charlie LLC',
    slug: 'charlie-llc',
    status: 'ACTIVE',
    tier: 'FREE',
    adminEmail: 'admin@charlie.com',
    createdAt: '2025-03-01T00:00:00Z',
    updatedAt: '2025-03-01T00:00:00Z',
  },
];

// 遅延をシミュレートする関数
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const mockTenantApi = {
  async listTenants(): Promise<Tenant[]> {
    await delay(500);
    return [...MOCK_TENANTS];
  },

  async getTenant(id: string): Promise<Tenant | null> {
    await delay(300);
    return MOCK_TENANTS.find((t) => t.id === id) || null;
  },

  async createTenant(input: CreateTenantInput): Promise<Tenant> {
    await delay(800);
    const newTenant: Tenant = {
      id: Math.random().toString(36).substring(7),
      ...input,
      status: 'ACTIVE',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    MOCK_TENANTS.push(newTenant);
    return newTenant;
  },

  async updateTenant(
    id: string,
    input: UpdateTenantInput
  ): Promise<Tenant | null> {
    await delay(500);
    const index = MOCK_TENANTS.findIndex((t) => t.id === id);
    if (index === -1) return null;

    MOCK_TENANTS[index] = {
      ...MOCK_TENANTS[index],
      ...input,
      updatedAt: new Date().toISOString(),
    };
    return MOCK_TENANTS[index];
  },

  async deleteTenant(id: string): Promise<boolean> {
    await delay(500);
    const index = MOCK_TENANTS.findIndex((t) => t.id === id);
    if (index === -1) return false;

    MOCK_TENANTS.splice(index, 1);
    return true;
  },
};
