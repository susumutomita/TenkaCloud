import type { OnePassStepResult, OnePassTarget } from '../../packages/shared/src/quality';

export interface CliOptions {
  target: OnePassTarget;
  allowBlocked: boolean;
  pollIntervalMs: number;
  provisionTimeoutMs: number;
}

export interface HarnessConfig {
  target: OnePassTarget;
  controlPlaneApiBaseUrl: string;
  applicationAdminApiBaseUrl: string;
  applicationParticipantApiBaseUrl: string;
  applicationPlaneUrl: string;
  gamedayApiBaseUrl: string;
  controlPlaneToken?: string;
  applicationAdminToken?: string;
  applicationParticipantToken?: string;
}

export interface DevIdentityHeaders {
  'X-TenkaCloud-Dev-User-Id'?: string;
  'X-TenkaCloud-Dev-Tenant-Id'?: string;
  'X-TenkaCloud-Dev-Roles'?: string;
}

export interface TenantProvisioningStatus {
  tenantId: string;
  provisioningStatus: string;
  applicationDeploymentStatus?: string;
  provisionedResources?: unknown;
  provisioningError?: string | null;
  provisionedAt?: string | null;
  provisioningEnabled: boolean;
}

export interface TenantResponse {
  id: string;
  slug: string;
  computeType: string;
}

export interface EventResponse {
  id: string;
  name: string;
}

export interface ProblemResponse {
  id: string;
  title: string;
}

export interface DeployProblemResponse {
  stackName?: string;
  outputs?: Record<string, string>;
}

export interface OnePassState {
  runId: string;
  devTenantId: string;
  adminHeaders: DevIdentityHeaders;
  participantHeaders: DevIdentityHeaders;
  tenant: TenantResponse | null;
  provisioningStatus: TenantProvisioningStatus | null;
  event: EventResponse | null;
  problem: ProblemResponse | null;
}

export type StepRunner = (
  config: HarnessConfig,
  options: CliOptions,
  state: OnePassState,
) => Promise<OnePassStepResult[]>;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function getConfig(target: OnePassTarget): HarnessConfig {
  if (target === 'local') {
    return {
      target,
      controlPlaneApiBaseUrl:
        process.env.ONE_PASS_CONTROL_PLANE_API_BASE_URL ??
        'http://localhost:13004/api',
      applicationAdminApiBaseUrl:
        process.env.ONE_PASS_APPLICATION_ADMIN_API_BASE_URL ??
        'http://localhost:3100/api',
      applicationParticipantApiBaseUrl:
        process.env.ONE_PASS_APPLICATION_PARTICIPANT_API_BASE_URL ??
        'http://localhost:3100/api',
      applicationPlaneUrl:
        process.env.ONE_PASS_APPLICATION_PLANE_URL ?? 'http://localhost:13001',
      gamedayApiBaseUrl:
        process.env.ONE_PASS_GAMEDAY_API_BASE_URL ?? 'http://localhost:3020',
      controlPlaneToken:
        process.env.ONE_PASS_CONTROL_PLANE_TOKEN ?? 'mock-access-token',
      applicationAdminToken:
        process.env.ONE_PASS_APPLICATION_ADMIN_TOKEN ?? 'mock-access-token',
      applicationParticipantToken:
        process.env.ONE_PASS_APPLICATION_PARTICIPANT_TOKEN ??
        'mock-access-token',
    };
  }

  return {
    target,
    controlPlaneApiBaseUrl: requireEnv('ONE_PASS_CONTROL_PLANE_API_BASE_URL'),
    applicationAdminApiBaseUrl: requireEnv(
      'ONE_PASS_APPLICATION_ADMIN_API_BASE_URL',
    ),
    applicationParticipantApiBaseUrl: requireEnv(
      'ONE_PASS_APPLICATION_PARTICIPANT_API_BASE_URL',
    ),
    applicationPlaneUrl: requireEnv('ONE_PASS_APPLICATION_PLANE_URL'),
    gamedayApiBaseUrl: requireEnv('ONE_PASS_GAMEDAY_API_BASE_URL'),
    controlPlaneToken: requireEnv('ONE_PASS_CONTROL_PLANE_TOKEN'),
    applicationAdminToken: requireEnv('ONE_PASS_APPLICATION_ADMIN_TOKEN'),
    applicationParticipantToken: requireEnv('ONE_PASS_APPLICATION_PARTICIPANT_TOKEN'),
  };
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    target: 'local',
    allowBlocked: false,
    pollIntervalMs: 1000,
    provisionTimeoutMs: 20000,
  };

  for (const arg of argv) {
    if (arg === '--allow-blocked') {
      options.allowBlocked = true;
      continue;
    }

    if (arg.startsWith('--target=')) {
      const target = arg.slice('--target='.length);
      if (target === 'local' || target === 'aws') {
        options.target = target;
      }
      continue;
    }

    if (arg.startsWith('--poll-interval-ms=')) {
      const value = Number.parseInt(arg.slice('--poll-interval-ms='.length), 10);
      if (Number.isFinite(value) && value > 0) {
        options.pollIntervalMs = value;
      }
      continue;
    }

    if (arg.startsWith('--provision-timeout-ms=')) {
      const value = Number.parseInt(
        arg.slice('--provision-timeout-ms='.length),
        10,
      );
      if (Number.isFinite(value) && value > 0) {
        options.provisionTimeoutMs = value;
      }
    }
  }

  return options;
}

export function createStep(
  id: string,
  label: string,
  status: OnePassStepResult['status'],
  detail: string,
  hint?: string,
): OnePassStepResult {
  return { id, label, status, detail, hint };
}

export function timestampSuffix(): string {
  return `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 17)}${crypto.randomUUID().replace(/-/g, '').slice(0, 6)}`;
}

export function createDevHeaders(input: {
  userId: string;
  tenantId: string;
  roles: string[];
}): DevIdentityHeaders {
  return {
    'X-TenkaCloud-Dev-User-Id': input.userId,
    'X-TenkaCloud-Dev-Tenant-Id': input.tenantId,
    'X-TenkaCloud-Dev-Roles': input.roles.join(','),
  };
}

export function gamedayAdminUrl(config: HarnessConfig, path: string): string {
  return `${config.gamedayApiBaseUrl}/api/gameday/admin${path}`;
}

export function gamedayParticipantUrl(config: HarnessConfig, path: string): string {
  return `${config.gamedayApiBaseUrl}/api/gameday${path}`;
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
