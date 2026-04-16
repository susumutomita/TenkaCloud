/**
 * SBT Control Plane API Adapter
 *
 * Translates between the UI's Tenant model and SBT's tenant-registrations API.
 * Used when CONTROL_PLANE_API_URL is set (production with SBT).
 */

import type {
  CreateTenantInput,
  Tenant,
  TenantTier,
  UpdateTenantInput,
} from '@/types/tenant';
import { TENANT_TIERS } from '@/types/tenant';
import { z } from 'zod';
import { TenantApiError } from './tenant-api';

// Zod schemas for SBT API response validation
const SbtTenantRegistrationSchema = z.object({
  tenantId: z.string(),
  tenantRegistrationId: z.string().optional(),
  tenantName: z.string(),
  email: z.string(),
  tier: z.string().optional(),
  tenantStatus: z.string(),
  registrationStatus: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

const SbtTenantRegistrationListResponseSchema = z.object({
  data: z.array(SbtTenantRegistrationSchema),
});

// SBT API response types (derived from Zod schemas)
type SbtTenantRegistration = z.infer<typeof SbtTenantRegistrationSchema>;
type SbtTenantRegistrationListResponse = z.infer<
  typeof SbtTenantRegistrationListResponseSchema
>;

function parseTier(raw: string | undefined): TenantTier {
  const upper = raw?.toUpperCase();
  if (upper && (TENANT_TIERS as readonly string[]).includes(upper)) {
    return upper as TenantTier;
  }
  return 'FREE';
}

function toTenant(reg: SbtTenantRegistration): Tenant {
  return {
    id: reg.tenantId,
    name: reg.tenantName,
    slug: reg.tenantName.toLowerCase().replace(/\s+/g, '-'),
    status: 'ACTIVE',
    tier: parseTier(reg.tier),
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
    createdAt: reg.createdAt ?? '',
    updatedAt: reg.updatedAt ?? '',
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
      const raw = await sbtFetch<unknown>('/tenant-registrations');
      const parsed = SbtTenantRegistrationListResponseSchema.safeParse(raw);
      if (!parsed.success) {
        throw new TenantApiError(
          502,
          `Invalid SBT list response: ${parsed.error.message}`,
        );
      }
      return parsed.data.data.map(toTenant);
    },

    async getTenant(id: string): Promise<Tenant | null> {
      try {
        const raw = await sbtFetch<unknown>(`/tenant-registrations/${id}`);
        const parsed = SbtTenantRegistrationSchema.safeParse(raw);
        if (!parsed.success) {
          throw new TenantApiError(
            502,
            `Invalid SBT tenant response: ${parsed.error.message}`,
          );
        }
        return toTenant(parsed.data);
      } catch (err) {
        if (err instanceof TenantApiError && err.status === 404) return null;
        throw err;
      }
    },

    async createTenant(input: CreateTenantInput): Promise<Tenant> {
      const raw = await sbtFetch<unknown>('/tenant-registrations', {
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
      });
      const parsed = z
        .object({ data: SbtTenantRegistrationSchema })
        .safeParse(raw);
      if (!parsed.success) {
        throw new TenantApiError(
          502,
          `Invalid SBT create response: ${parsed.error.message}`,
        );
      }
      return toTenant(parsed.data.data);
    },

    async updateTenant(
      id: string,
      input: UpdateTenantInput,
    ): Promise<Tenant | null> {
      try {
        const raw = await sbtFetch<unknown>(`/tenants/${id}`, {
          method: 'PUT',
          body: JSON.stringify({
            tenantName: input.name,
            tier: input.tier?.toLowerCase(),
          }),
        });
        const parsed = SbtTenantRegistrationSchema.safeParse(raw);
        if (!parsed.success) {
          throw new TenantApiError(
            502,
            `Invalid SBT update response: ${parsed.error.message}`,
          );
        }
        return toTenant(parsed.data);
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
        const raw = await sbtFetch<unknown>(`/tenant-registrations/${id}`);
        const parsed = SbtTenantRegistrationSchema.safeParse(raw);
        if (!parsed.success) {
          throw new TenantApiError(
            502,
            `Invalid SBT provisioning response: ${parsed.error.message}`,
          );
        }
        return {
          tenantId: parsed.data.tenantId,
          provisioningStatus:
            parsed.data.tenantStatus === 'created'
              ? 'COMPLETED'
              : 'IN_PROGRESS',
          provisioningEnabled: true,
        };
      } catch (err) {
        if (err instanceof TenantApiError && err.status === 404) return null;
        throw err;
      }
    },
  };
}
