import type {
  CreateTenantInput,
  Tenant,
  UpdateTenantInput,
} from '@/types/tenant';
import { mockTenantApi } from './mock-tenant-api';

// Use NEXT_PUBLIC_TENANT_API_BASE_URL for client components, fall back to server-side env.
const apiBaseUrl =
  process.env.NEXT_PUBLIC_TENANT_API_BASE_URL ||
  process.env.TENANT_API_BASE_URL;

const shouldUseMock = !apiBaseUrl;

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
    const res = await fetch(`${apiBaseUrl}/tenants`, { cache: 'no-store' });
    return handleResponse<Tenant[]>(res);
  },

  async getTenant(id: string): Promise<Tenant | null> {
    if (shouldUseMock) return mockTenantApi.getTenant(id);
    const res = await fetch(`${apiBaseUrl}/tenants/${id}`, {
      cache: 'no-store',
    });
    if (res.status === 404) return null;
    return handleResponse<Tenant>(res);
  },

  async createTenant(input: CreateTenantInput): Promise<Tenant> {
    if (shouldUseMock) return mockTenantApi.createTenant(input);
    const res = await fetch(`${apiBaseUrl}/tenants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    return handleResponse<Tenant>(res);
  },

  async updateTenant(
    id: string,
    input: UpdateTenantInput
  ): Promise<Tenant | null> {
    if (shouldUseMock) return mockTenantApi.updateTenant(id, input);
    const res = await fetch(`${apiBaseUrl}/tenants/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (res.status === 404) return null;
    return handleResponse<Tenant>(res);
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
