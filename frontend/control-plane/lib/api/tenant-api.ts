import type {
  CreateTenantInput,
  Tenant,
  UpdateTenantInput,
} from '@/types/tenant';
import { mockTenantApi } from './mock-tenant-api';

// Use NEXT_PUBLIC_TENANT_API_BASE_URL for client components, fall back to server-side env.
const isServer = typeof window === 'undefined';
const apiBaseUrl = isServer
  ? process.env.TENANT_API_BASE_URL || 'http://tenant-management:3004/api'
  : process.env.NEXT_PUBLIC_TENANT_API_BASE_URL || 'http://localhost:3004/api';

const shouldUseMock = false; // Force usage of real API

type ApiTenant = {
  id: string;
  name: string;
  status: string;
  tier: string;
  adminEmail: string;
  createdAt: string;
  updatedAt: string;
};

const normalizeTenant = (tenant: ApiTenant): Tenant => ({
  ...tenant,
  status: tenant.status.toLowerCase() as Tenant['status'],
  tier: tenant.tier.toLowerCase() as Tenant['tier'],
});

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Tenant API request failed: ${res.status} ${body}`);
  }
  return res.json() as Promise<T>;
}

export const tenantApi = {
  async listTenants(): Promise<Tenant[]> {
    if (shouldUseMock) return mockTenantApi.listTenants();
    try {
      const res = await fetch(`${apiBaseUrl}/tenants`, { cache: 'no-store' });
      const data = await handleResponse<ApiTenant[]>(res);
      return data.map(normalizeTenant);
    } catch (e) {
      console.warn('Tenant API listTenants failed, fallback to mock', e);
      return mockTenantApi.listTenants();
    }
  },

  async getTenant(id: string): Promise<Tenant | null> {
    if (shouldUseMock) return mockTenantApi.getTenant(id);
    try {
      const res = await fetch(`${apiBaseUrl}/tenants/${id}`, {
        cache: 'no-store',
      });
      if (res.status === 404) return null;
      const data = await handleResponse<ApiTenant>(res);
      return normalizeTenant(data);
    } catch (e) {
      console.warn('Tenant API getTenant failed, fallback to mock', e);
      return mockTenantApi.getTenant(id);
    }
  },

  async createTenant(input: CreateTenantInput): Promise<Tenant> {
    if (shouldUseMock) return mockTenantApi.createTenant(input);
    try {
      const res = await fetch(`${apiBaseUrl}/tenants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      const data = await handleResponse<ApiTenant>(res);
      return normalizeTenant(data);
    } catch (e) {
      console.warn('Tenant API createTenant failed, fallback to mock', e);
      return mockTenantApi.createTenant(input);
    }
  },

  async updateTenant(
    id: string,
    input: UpdateTenantInput
  ): Promise<Tenant | null> {
    if (shouldUseMock) return mockTenantApi.updateTenant(id, input);
    try {
      const res = await fetch(`${apiBaseUrl}/tenants/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (res.status === 404) return null;
      const data = await handleResponse<ApiTenant>(res);
      return normalizeTenant(data);
    } catch (e) {
      console.warn('Tenant API updateTenant failed, fallback to mock', e);
      return mockTenantApi.updateTenant(id, input);
    }
  },

  async deleteTenant(id: string): Promise<boolean> {
    if (shouldUseMock) return mockTenantApi.deleteTenant(id);
    const res = await fetch(`${apiBaseUrl}/tenants/${id}`, {
      method: 'DELETE',
    });
    if (res.status === 404) return false;
    await handleResponse<unknown>(res);
    return true;
  },
};
