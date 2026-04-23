/**
 * SBT Control Plane API Adapter
 *
 * Translates between the UI's Tenant model and SBT v0.3.9's flat /tenants API.
 * Used when CONTROL_PLANE_API_URL is set (production with SBT).
 *
 * Wire format正本: docs/decisions/013-sbt-control-plane-onboarding-wire-format.md
 */

import type {
  CreateTenantInput,
  ProvisioningStatus,
  Tenant,
  TenantTier,
  UpdateTenantInput,
} from '@/types/tenant';
import { z } from 'zod';
import { TenantApiError } from './tenant-api';

// SBT v0.3.9 tier values: basic / standard / premium / platinum (server/bin/cdk.ts の
// apiKeySSMParameterNames と一致させる)。platinum は UI 側に区別がないため
// ENTERPRISE に丸める (UI からは送出しない、受信時のみ畳み込む)。
const TIER_TO_SBT: Record<TenantTier, string> = {
  FREE: 'basic',
  PRO: 'standard',
  ENTERPRISE: 'premium',
};

function fromSbtTier(raw: string | undefined): TenantTier {
  switch (raw?.toLowerCase()) {
    case 'basic':
      return 'FREE';
    case 'standard':
      return 'PRO';
    case 'premium':
    case 'platinum':
      return 'ENTERPRISE';
    default:
      return 'FREE';
  }
}

// SBT tenantStatus enum (ADR-013 § 4)。UI 側の ProvisioningStatus に変換する。
const SBT_STATUS = {
  inProgress: 'In progress',
  complete: 'Complete',
  deleted: 'Deleted',
} as const;

function provisioningStatusFromSbt(status: string): ProvisioningStatus {
  switch (status) {
    case SBT_STATUS.complete:
      return 'COMPLETED';
    case SBT_STATUS.inProgress:
      return 'IN_PROGRESS';
    case SBT_STATUS.deleted:
      return 'FAILED';
    default:
      return 'PENDING';
  }
}

// Slug は SBT に存在しない概念 (UI 専用の URL 識別子)。tenantName から派生させるが、
// 非 ASCII (例: 日本語) を含む場合は URL safe にならないので tenantId にフォールバックする。
function deriveSlug(tenantName: string, tenantId: string): string {
  const ascii = tenantName
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
  return ascii.length >= 3 ? ascii : tenantId;
}

const SbtTenantSchema = z.object({
  tenantId: z.string(),
  tenantName: z.string(),
  email: z.string(),
  tier: z.string().optional(),
  tenantStatus: z.string(),
  isActive: z.boolean().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

type SbtTenant = z.infer<typeof SbtTenantSchema>;

// list/single とも、SBT は { data: T } で包むケースと直接返すケースがある。
// .transform() で unwrap まで Zod 内に閉じる。
const SbtSingleResponseSchema = z
  .union([z.object({ data: SbtTenantSchema }), SbtTenantSchema])
  .transform((v) => ('data' in v ? v.data : v));

const SbtListResponseSchema = z
  .union([
    z.object({ data: z.array(SbtTenantSchema) }),
    z.array(SbtTenantSchema),
  ])
  .transform((v) => (Array.isArray(v) ? v : v.data));

function parseOr502<S extends z.ZodTypeAny>(
  schema: S,
  raw: unknown,
): z.infer<S> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new TenantApiError(
      502,
      `Invalid SBT response: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

function toTenant(reg: SbtTenant): Tenant {
  const tier = fromSbtTier(reg.tier);
  return {
    id: reg.tenantId,
    name: reg.tenantName,
    slug: deriveSlug(reg.tenantName, reg.tenantId),
    status: reg.isActive === false ? 'ARCHIVED' : 'ACTIVE',
    tier,
    adminEmail: reg.email,
    region: 'ap-northeast-1',
    isolationModel: tier === 'ENTERPRISE' ? 'SILO' : 'POOL',
    computeType: 'SERVERLESS',
    provisioningStatus: provisioningStatusFromSbt(reg.tenantStatus),
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
      const raw = await sbtFetch<unknown>('/tenants');
      return parseOr502(SbtListResponseSchema, raw).map(toTenant);
    },

    async getTenant(id: string): Promise<Tenant | null> {
      try {
        const raw = await sbtFetch<unknown>(
          `/tenants/${encodeURIComponent(id)}`,
        );
        return toTenant(parseOr502(SbtSingleResponseSchema, raw));
      } catch (err) {
        if (err instanceof TenantApiError && err.status === 404) return null;
        throw err;
      }
    },

    async createTenant(input: CreateTenantInput): Promise<Tenant> {
      const raw = await sbtFetch<unknown>('/tenants', {
        method: 'POST',
        body: JSON.stringify({
          tenantName: input.name,
          email: input.adminEmail,
          tier: TIER_TO_SBT[input.tier],
          tenantStatus: SBT_STATUS.inProgress,
        }),
      });
      return toTenant(parseOr502(SbtSingleResponseSchema, raw));
    },

    async updateTenant(
      id: string,
      input: UpdateTenantInput,
    ): Promise<Tenant | null> {
      try {
        const body: Record<string, string> = {};
        if (input.name !== undefined) body.tenantName = input.name;
        if (input.adminEmail !== undefined) body.email = input.adminEmail;
        if (input.tier !== undefined) body.tier = TIER_TO_SBT[input.tier];

        const raw = await sbtFetch<unknown>(
          `/tenants/${encodeURIComponent(id)}`,
          {
            method: 'PUT',
            body: JSON.stringify(body),
          },
        );
        return toTenant(parseOr502(SbtSingleResponseSchema, raw));
      } catch (err) {
        if (err instanceof TenantApiError && err.status === 404) return null;
        throw err;
      }
    },

    async deleteTenant(id: string): Promise<boolean> {
      try {
        await sbtFetch(`/tenants/${encodeURIComponent(id)}`, {
          method: 'DELETE',
        });
        return true;
      } catch (err) {
        if (err instanceof TenantApiError && err.status === 404) return false;
        throw err;
      }
    },

    async triggerProvisioning(_id: string): Promise<{
      success: boolean;
      message: string;
      provisioningStatus: ProvisioningStatus;
    }> {
      // SBT triggers provisioning automatically on tenant creation via EventBridge.
      return {
        success: true,
        message: 'Provisioning is handled automatically by SBT EventBridge',
        provisioningStatus: 'IN_PROGRESS',
      };
    },

    async getProvisioningStatus(id: string): Promise<{
      tenantId: string;
      provisioningStatus: ProvisioningStatus;
      applicationPlaneEndpoint?: string;
      provisioningEnabled: boolean;
    } | null> {
      try {
        const raw = await sbtFetch<unknown>(
          `/tenants/${encodeURIComponent(id)}`,
        );
        const tenant = parseOr502(SbtSingleResponseSchema, raw);
        return {
          tenantId: tenant.tenantId,
          provisioningStatus: provisioningStatusFromSbt(tenant.tenantStatus),
          provisioningEnabled: true,
        };
      } catch (err) {
        if (err instanceof TenantApiError && err.status === 404) return null;
        throw err;
      }
    },
  };
}
