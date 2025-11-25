import type {
  CreateTenantInput,
  Tenant,
  UpdateTenantInput,
} from '@/types/tenant';

/** HTTP ステータスコード定数 */
const HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INTERNAL_SERVER_ERROR: 500,
} as const;

// Use NEXT_PUBLIC_TENANT_API_BASE_URL for client components, fall back to server-side env.
const isServer = typeof window === 'undefined';
const apiBaseUrl = isServer
  ? process.env.TENANT_API_BASE_URL || 'http://tenant-management:3004/api'
  : process.env.NEXT_PUBLIC_TENANT_API_BASE_URL || 'http://localhost:3004/api';

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Tenant API request failed: ${res.status} ${body}`);
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
    if (res.status === HTTP_STATUS.NOT_FOUND) return null;
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
    if (res.status === HTTP_STATUS.NOT_FOUND) return null;
    return handleResponse<Tenant>(res);
  },

  async deleteTenant(id: string): Promise<boolean> {
    const res = await fetch(`${apiBaseUrl}/tenants/${id}`, {
      method: 'DELETE',
    });
    if (res.status === HTTP_STATUS.NOT_FOUND) return false;
    await handleResponse<unknown>(res);
    return true;
  },
};
