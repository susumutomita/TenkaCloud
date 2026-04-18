export type TenantStatus = 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED';
export type TenantTier = 'FREE' | 'PRO' | 'ENTERPRISE';
export type SupportLevel = 'community' | 'email' | 'priority';
export type ProvisioningStatus =
  | 'PENDING'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'FAILED';
export type ApplicationDeploymentStatus =
  | 'NOT_DEPLOYED'
  | 'DEPLOYING'
  | 'DEPLOYED'
  | 'FAILED';
export type IsolationModel = 'POOL' | 'SILO';
export type ComputeType = 'SERVERLESS' | 'KUBERNETES';

export const TENANT_STATUSES: readonly TenantStatus[] = [
  'ACTIVE',
  'SUSPENDED',
  'ARCHIVED',
] as const;

export const TENANT_TIERS: readonly TenantTier[] = [
  'FREE',
  'PRO',
  'ENTERPRISE',
] as const;

export const PROVISIONING_STATUSES: readonly ProvisioningStatus[] = [
  'PENDING',
  'IN_PROGRESS',
  'COMPLETED',
  'FAILED',
] as const;

export const APPLICATION_DEPLOYMENT_STATUSES: readonly ApplicationDeploymentStatus[] =
  ['NOT_DEPLOYED', 'DEPLOYING', 'DEPLOYED', 'FAILED'] as const;

export const ISOLATION_MODELS: readonly IsolationModel[] = [
  'POOL',
  'SILO',
] as const;

export const COMPUTE_TYPES: readonly ComputeType[] = [
  'SERVERLESS',
  'KUBERNETES',
] as const;

export const TENANT_STATUS_LABELS: Record<TenantStatus, string> = {
  ACTIVE: 'Active',
  SUSPENDED: 'Suspended',
  ARCHIVED: 'Archived',
};

export const TENANT_TIER_LABELS: Record<TenantTier, string> = {
  FREE: 'Free',
  PRO: 'Pro',
  ENTERPRISE: 'Enterprise',
};

export const PROVISIONING_STATUS_LABELS: Record<ProvisioningStatus, string> = {
  PENDING: 'Pending',
  IN_PROGRESS: 'In Progress',
  COMPLETED: 'Completed',
  FAILED: 'Failed',
};

export const APPLICATION_DEPLOYMENT_STATUS_LABELS: Record<
  ApplicationDeploymentStatus,
  string
> = {
  NOT_DEPLOYED: 'Not Deployed',
  DEPLOYING: 'Deploying',
  DEPLOYED: 'Deployed',
  FAILED: 'Failed',
};

export interface TenantProvisionedService {
  name: string;
  kind?: 'ui' | 'api' | 'worker' | 'storage' | 'identity' | 'observability';
  endpoint?: string;
}

export interface TenantProvisionedResources {
  s3Bucket?: string;
  s3Prefix?: string;
  iamRoleArn?: string;
  cloudwatchLogGroup?: string;
  auth0OrganizationId?: string;
  services?: TenantProvisionedService[];
}

export const ISOLATION_MODEL_LABELS: Record<IsolationModel, string> = {
  POOL: 'Pool（共有）',
  SILO: 'Silo（専有）',
};

export const COMPUTE_TYPE_LABELS: Record<ComputeType, string> = {
  SERVERLESS: 'Serverless',
  KUBERNETES: 'Kubernetes',
};

export interface TierFeatures {
  maxParticipants: number; // -1 = 無制限
  maxBattles: number; // 月間最大バトル数, -1 = 無制限
  maxProblems: number; // 最大問題数, -1 = 無制限
  customBranding: boolean;
  apiAccess: boolean;
  ssoEnabled: boolean;
  supportLevel: SupportLevel;
  isolationModel: IsolationModel;
}

export const TIER_FEATURES: Record<TenantTier, TierFeatures> = {
  FREE: {
    maxParticipants: 10,
    maxBattles: 5,
    maxProblems: 20,
    customBranding: false,
    apiAccess: false,
    ssoEnabled: false,
    supportLevel: 'community',
    isolationModel: 'POOL',
  },
  PRO: {
    maxParticipants: 100,
    maxBattles: 50,
    maxProblems: 200,
    customBranding: true,
    apiAccess: true,
    ssoEnabled: false,
    supportLevel: 'email',
    isolationModel: 'POOL',
  },
  ENTERPRISE: {
    maxParticipants: -1,
    maxBattles: -1,
    maxProblems: -1,
    customBranding: true,
    apiAccess: true,
    ssoEnabled: true,
    supportLevel: 'priority',
    isolationModel: 'SILO',
  },
};

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  status: TenantStatus;
  tier: TenantTier;
  adminEmail: string;
  adminName?: string;
  region: string;
  isolationModel: IsolationModel;
  computeType: ComputeType;
  provisioningStatus: ProvisioningStatus;
  applicationDeploymentStatus?: ApplicationDeploymentStatus;
  applicationPlaneEndpoint?: string;
  provisionedResources?: TenantProvisionedResources;
  provisioningError?: string;
  provisionedAt?: string;
  auth0OrgId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTenantInput {
  name: string;
  slug: string;
  adminEmail: string;
  adminName?: string;
  tier: TenantTier;
  region?: string;
  isolationModel?: IsolationModel;
  computeType?: ComputeType;
}

export interface UpdateTenantInput {
  name?: string;
  adminEmail?: string;
  status?: TenantStatus;
  tier?: TenantTier;
}
