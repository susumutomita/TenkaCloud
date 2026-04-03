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
    region: 'ap-northeast-1',
    isolationModel: 'SILO',
    computeType: 'KUBERNETES',
    provisioningStatus: 'COMPLETED',
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
    region: 'us-east-1',
    isolationModel: 'POOL',
    computeType: 'SERVERLESS',
    provisioningStatus: 'COMPLETED',
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
    region: 'ap-northeast-1',
    isolationModel: 'POOL',
    computeType: 'SERVERLESS',
    provisioningStatus: 'COMPLETED',
    createdAt: '2025-03-01T00:00:00Z',
    updatedAt: '2025-03-01T00:00:00Z',
  },
];

// \u9045\u5ef6\u3092\u30b7\u30df\u30e5\u30ec\u30fc\u30c8\u3059\u308b\u95a2\u6570
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
      name: input.name,
      slug: input.slug,
      adminEmail: input.adminEmail,
      adminName: input.adminName,
      tier: input.tier,
      status: 'ACTIVE',
      region: input.region ?? 'ap-northeast-1',
      isolationModel: input.isolationModel ?? 'POOL',
      computeType: input.computeType ?? 'SERVERLESS',
      provisioningStatus: 'PENDING',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    MOCK_TENANTS.push(newTenant);
    return newTenant;
  },

  async updateTenant(
    id: string,
    input: UpdateTenantInput,
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

  async triggerProvisioning(id: string): Promise<{
    success: boolean;
    message: string;
    provisioningStatus: string;
  }> {
    await delay(500);
    const tenant = MOCK_TENANTS.find((t) => t.id === id);
    if (!tenant) {
      return {
        success: false,
        message: '\u30c6\u30ca\u30f3\u30c8\u304c\u898b\u3064\u304b\u308a\u307e\u305b\u3093',
        provisioningStatus: 'PENDING',
      };
    }
    tenant.provisioningStatus = 'IN_PROGRESS';
    tenant.updatedAt = new Date().toISOString();
    return {
      success: true,
      message: '\u30d7\u30ed\u30d3\u30b8\u30e7\u30cb\u30f3\u30b0\u3092\u958b\u59cb\u3057\u307e\u3057\u305f',
      provisioningStatus: 'IN_PROGRESS',
    };
  },

  async getProvisioningStatus(id: string): Promise<{
    tenantId: string;
    provisioningStatus: string;
    provisioningEnabled: boolean;
  } | null> {
    await delay(300);
    const tenant = MOCK_TENANTS.find((t) => t.id === id);
    if (!tenant) return null;
    return {
      tenantId: tenant.id,
      provisioningStatus: tenant.provisioningStatus,
      provisioningEnabled: true,
    };
  },
};
