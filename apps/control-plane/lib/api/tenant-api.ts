import { StatusCodes } from 'http-status-codes';
import type {
  CreateTenantInput,
  Tenant,
  UpdateTenantInput,
} from '@/types/tenant';

// Use NEXT_PUBLIC_TENANT_API_BASE_URL for client components, fall back to server-side env.
const isServer = typeof window === 'undefined';
const apiBaseUrl = isServer
  ? process.env.TENANT_API_BASE_URL || 'http://tenant-management:3004/api'
  : process.env.NEXT_PUBLIC_TENANT_API_BASE_URL || 'http://localhost:3004/api';

export class TenantApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly userMessage: string
  ) {
    super(userMessage);
    this.name = 'TenantApiError';
  }
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text();
    let userMessage = 'APIリクエストに失敗しました';
    try {
      const json = JSON.parse(body);
      if (json.error?.message) {
        userMessage = json.error.message;
      } else if (json.message) {
        userMessage = json.message;
      }
    } catch {
      // JSON パース失敗時はデフォルトメッセージを使用
    }
    throw new TenantApiError(res.status, userMessage);
  }
  return res.json() as Promise<T>;
}

type PaginatedResponse<T> = {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPreviousPage: boolean;
  };
};

export const tenantApi = {
  async listTenants(): Promise<Tenant[]> {
    const res = await fetch(`${apiBaseUrl}/tenants`, { cache: 'no-store' });
    const response = await handleResponse<PaginatedResponse<Tenant>>(res);
    return response.data;
  },

  async getTenant(id: string): Promise<Tenant | null> {
    const res = await fetch(`${apiBaseUrl}/tenants/${id}`, {
      cache: 'no-store',
    });
    if (res.status === StatusCodes.NOT_FOUND) return null;
    return handleResponse<Tenant>(res);
  },

  async createTenant(input: CreateTenantInput): Promise<Tenant> {
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
    const res = await fetch(`${apiBaseUrl}/tenants/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (res.status === StatusCodes.NOT_FOUND) return null;
    return handleResponse<Tenant>(res);
  },

  async deleteTenant(id: string): Promise<boolean> {
    const res = await fetch(`${apiBaseUrl}/tenants/${id}`, {
      method: 'DELETE',
    });
    if (res.status === StatusCodes.NOT_FOUND) return false;
    await handleResponse<unknown>(res);
    return true;
  },

  async triggerProvisioning(id: string): Promise<{
    success: boolean;
    message: string;
    provisioningStatus: string;
  }> {
    const res = await fetch(`${apiBaseUrl}/tenants/${id}/provision`, {
      method: 'POST',
    });
    return handleResponse<{
      success: boolean;
      message: string;
      provisioningStatus: string;
    }>(res);
  },

  async getProvisioningStatus(id: string): Promise<{
    tenantId: string;
    provisioningStatus: string;
    provisioningEnabled: boolean;
  } | null> {
    const res = await fetch(`${apiBaseUrl}/tenants/${id}/provision`, {
      cache: 'no-store',
    });
    if (res.status === StatusCodes.NOT_FOUND) return null;
    return handleResponse<{
      tenantId: string;
      provisioningStatus: string;
      provisioningEnabled: boolean;
    }>(res);
  },
};
