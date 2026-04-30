import { StatusCodes } from 'http-status-codes';
import { getCurrentIdToken } from '@/lib/auth/cognito-pkce';
import { loadConfig } from '@/lib/runtime-config';
import type {
  CreateTenantInput,
  Tenant,
  UpdateTenantInput,
} from '@/types/tenant';
import { createSbtTenantApi } from './sbt-api-adapter';

export class TenantApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly userMessage: string,
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
      } else if (typeof json.error === 'string') {
        userMessage = json.error;
      } else if (json.message) {
        userMessage = json.message;
      }
    } catch {
      // JSON parse failure: use default message
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

interface TenantApi {
  listTenants(): Promise<Tenant[]>;
  getTenant(id: string): Promise<Tenant | null>;
  createTenant(input: CreateTenantInput): Promise<Tenant>;
  updateTenant(id: string, input: UpdateTenantInput): Promise<Tenant | null>;
  deleteTenant(id: string): Promise<boolean>;
  triggerProvisioning(id: string): Promise<{
    success: boolean;
    message: string;
    provisioningStatus: string;
  }>;
  getProvisioningStatus(id: string): Promise<{
    tenantId: string;
    provisioningStatus: string;
    applicationDeploymentStatus?: string;
    applicationPlaneEndpoint?: string;
    provisionedResources?: unknown;
    provisioningError?: string | null;
    provisionedAt?: string | null;
    provisioningEnabled: boolean;
  } | null>;
}

// Local fallback (dev without runtime-config). Hits tenant-management:13004
// directly. Used when NEXT_PUBLIC_TENANT_API_BASE_URL is set.
function makeLocalApi(localApiBaseUrl: string): TenantApi {
  return {
    async listTenants(): Promise<Tenant[]> {
      const res = await fetch(`${localApiBaseUrl}/tenants`, {
        cache: 'no-store',
      });
      const response = await handleResponse<PaginatedResponse<Tenant>>(res);
      return response.data;
    },

    async getTenant(id: string): Promise<Tenant | null> {
      const res = await fetch(`${localApiBaseUrl}/tenants/${id}`, {
        cache: 'no-store',
      });
      if (res.status === StatusCodes.NOT_FOUND) return null;
      return handleResponse<Tenant>(res);
    },

    async createTenant(input: CreateTenantInput): Promise<Tenant> {
      const res = await fetch(`${localApiBaseUrl}/tenants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      return handleResponse<Tenant>(res);
    },

    async updateTenant(
      id: string,
      input: UpdateTenantInput,
    ): Promise<Tenant | null> {
      const res = await fetch(`${localApiBaseUrl}/tenants/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (res.status === StatusCodes.NOT_FOUND) return null;
      return handleResponse<Tenant>(res);
    },

    async deleteTenant(id: string): Promise<boolean> {
      const res = await fetch(`${localApiBaseUrl}/tenants/${id}`, {
        method: 'DELETE',
      });
      if (res.status === StatusCodes.NOT_FOUND) return false;
      await handleResponse<unknown>(res);
      return true;
    },

    async triggerProvisioning(id: string) {
      const res = await fetch(`${localApiBaseUrl}/tenants/${id}/provision`, {
        method: 'POST',
      });
      return handleResponse(res);
    },

    async getProvisioningStatus(id: string) {
      const res = await fetch(`${localApiBaseUrl}/tenants/${id}/provision`, {
        cache: 'no-store',
      });
      if (res.status === StatusCodes.NOT_FOUND) return null;
      return handleResponse(res);
    },
  };
}

let resolved: TenantApi | null = null;
let inflight: Promise<TenantApi> | null = null;

async function resolveApi(): Promise<TenantApi> {
  if (resolved) return resolved;
  if (inflight) return inflight;

  inflight = (async () => {
    const localBaseUrl = process.env.NEXT_PUBLIC_TENANT_API_BASE_URL;

    if (localBaseUrl) {
      resolved = makeLocalApi(localBaseUrl);
      return resolved;
    }

    const config = await loadConfig();
    resolved = createSbtTenantApi(config.apiBaseUrl, async () =>
      getCurrentIdToken(),
    );
    return resolved;
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

// Re-export shape — async-resolving facade preserves call sites.
export const tenantApi: TenantApi = {
  async listTenants() {
    return (await resolveApi()).listTenants();
  },
  async getTenant(id) {
    return (await resolveApi()).getTenant(id);
  },
  async createTenant(input) {
    return (await resolveApi()).createTenant(input);
  },
  async updateTenant(id, input) {
    return (await resolveApi()).updateTenant(id, input);
  },
  async deleteTenant(id) {
    return (await resolveApi()).deleteTenant(id);
  },
  async triggerProvisioning(id) {
    return (await resolveApi()).triggerProvisioning(id);
  },
  async getProvisioningStatus(id) {
    return (await resolveApi()).getProvisioningStatus(id);
  },
};
