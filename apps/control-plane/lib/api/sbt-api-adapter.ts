/**
 * SBT Control Plane API Adapter
 *
 * Translates between the UI's Tenant model and SBT's tenant-registrations API.
 * Used when CONTROL_PLANE_API_URL is set (production with SBT).
 */

import type {
  CreateTenantInput,
  Tenant,
  UpdateTenantInput,
} from '@/types/tenant';
import { TenantApiError } from './tenant-api';

// SBT API response types
interface SbtTenantRegistration {
  tenantId: string;
  tenantRegistrationId: string;
  tenantName: string;
  email: string;
  tier: string;
  tenantStatus: string;
  registrationStatus?: string;
}

interface SbtTenantRegistrationListResponse {
  data: SbtTenantRegistration[];
}

function toTenant(reg: SbtTenantRegistration): Tenant {
  return {
    id: reg.tenantId,
    name: reg.tenantName,
    slug: reg.tenantName.toLowerCase().replace(/\s+/g, '-'),
    status: 'ACTIVE',
    tier: (reg.tier?.toUpperCase() as Tenant['tier']) || 'FREE',
    adminEmail: reg.email,
    region: 'ap-northeast-1',
    isolationModel: 'POOL',
    computeType: 'SERVERLESS',
    provisioningStatus:
      reg.tenantStatus === 'created'
        ? 'COMPLETED'
        : reg.registrationStatus === 'In progress'
          ? 'IN_PROGRESS'
          : 'PENDING',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function createSbtTenantApi(
  baseUrl: string,
  getAccessToken: () => Promise<string | null>,
) {
  async function sbtFetch<T>(
    path: string,
    options: RequestInit = {},
  ): Promise<T> {
    const token = await getAccessToken();
    const res = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options.headers,
      },
    });

    if (!res.ok) {
      const body = await res.text();
      let message = 'SBT API request failed';
      try {
        const json = JSON.parse(body);
        message = json.message || json.error || message;
      } catch {
        // use default message
      }
      throw new TenantApiError(res.status, message);
    }

    return res.json() as Promise<T>;
  }

  return {
    async listTenants(): Promise<Tenant[]> {
      const response = await sbtFetch<SbtTenantRegistrationListResponse>(
        '/tenant-registrations',
      );
      return response.data.map(toTenant);
    },

    async getTenant(id: string): Promise<Tenant | null> {
      try {
        const reg = await sbtFetch<SbtTenantRegistration>(
          `/tenant-registrations/${id}`,
        );
        return toTenant(reg);
      } catch (err) {
        if (err instanceof TenantApiError && err.status === 404) return null;
        throw err;
      }
    },

    async createTenant(input: CreateTenantInput): Promise<Tenant> {
      const reg = await sbtFetch<{ data: SbtTenantRegistration }>(
        '/tenant-registrations',
        {
          method: 'POST',
          body: JSON.stringify({
            tenantData: {
              tenantName: input.name,
              email: input.adminEmail,
              tier: input.tier.toLowerCase(),
            },
            tenantRegistrationData: {
              registrationStatus: 'In progress',
            },
          }),
        },
      );
      return toTenant(reg.data);
    },

    async updateTenant(
      id: string,
      input: UpdateTenantInput,
    ): Promise<Tenant | null> {
      try {
        const reg = await sbtFetch<SbtTenantRegistration>(`/tenants/${id}`, {
          method: 'PUT',
          body: JSON.stringify({
            tenantName: input.name,
            tier: input.tier?.toLowerCase(),
          }),
        });
        return toTenant(reg);
      } catch (err) {
        if (err instanceof TenantApiError && err.status === 404) return null;
        throw err;
      }
    },

    async deleteTenant(id: string): Promise<boolean> {
      try {
        await sbtFetch(`/tenant-registrations/${id}`, { method: 'DELETE' });
        return true;
      } catch (err) {
        if (err instanceof TenantApiError && err.status === 404) return false;
        throw err;
      }
    },

    async triggerProvisioning(_id: string): Promise<{
      success: boolean;
      message: string;
      provisioningStatus: string;
    }> {
      // SBT triggers provisioning automatically on tenant creation via EventBridge.
      // This is a no-op when using SBT.
      return {
        success: true,
        message: 'Provisioning is handled automatically by SBT EventBridge',
        provisioningStatus: 'IN_PROGRESS',
      };
    },

    async getProvisioningStatus(id: string): Promise<{
      tenantId: string;
      provisioningStatus: string;
      provisioningEnabled: boolean;
    } | null> {
      try {
        const reg = await sbtFetch<SbtTenantRegistration>(
          `/tenant-registrations/${id}`,
        );
        return {
          tenantId: reg.tenantId,
          provisioningStatus:
            reg.tenantStatus === 'created' ? 'COMPLETED' : 'IN_PROGRESS',
          provisioningEnabled: true,
        };
      } catch (err) {
        if (err instanceof TenantApiError && err.status === 404) return null;
        throw err;
      }
    },
  };
}
