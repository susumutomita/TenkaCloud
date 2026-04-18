import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockUpdate = vi.hoisted(() => vi.fn());
const mockUpdateProvisioningStatus = vi.hoisted(() => vi.fn());

vi.mock('../lib/dynamodb', () => ({
  tenantRepository: {
    update: mockUpdate,
    updateProvisioningStatus: mockUpdateProvisioningStatus,
  },
}));

vi.mock('./keycloak', () => ({
  KeycloakProvisioner: vi.fn().mockImplementation(() => ({
    createRealm: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('./kubernetes', () => ({
  KubernetesProvisioner: vi.fn().mockImplementation(() => ({
    createNamespace: vi.fn().mockResolvedValue('test-tenant'),
    deployParticipantApp: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

import type { Tenant } from '@tenkacloud/dynamodb';
import {
  ProvisioningManager,
  resolveApplicationPlaneEndpoint,
} from './manager';

const mockTenant: Tenant = {
  id: '01HJXK5K3VDXK5YPNZBKRT5ABC',
  name: 'Test Tenant',
  slug: 'test-tenant',
  adminEmail: 'admin@example.com',
  tier: 'FREE',
  status: 'ACTIVE',
  region: 'ap-northeast-1',
  isolationModel: 'POOL',
  computeType: 'SERVERLESS',
  provisioningStatus: 'PENDING',
  createdAt: new Date('2026-04-11T00:00:00.000Z'),
  updatedAt: new Date('2026-04-11T00:00:00.000Z'),
};

describe('resolveApplicationPlaneEndpoint', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('APPLICATION_PLANE_BASE_URL が設定されている場合はそれを使用すべき', () => {
    vi.stubEnv('APPLICATION_PLANE_BASE_URL', 'https://app.example.com');
    const result = resolveApplicationPlaneEndpoint('my-tenant');
    expect(result).toBe('https://app.example.com?tenant=my-tenant');
  });

  it('本番環境ではサブドメイン形式の URL を返すべき', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const result = resolveApplicationPlaneEndpoint('my-tenant');
    expect(result).toBe('https://my-tenant.tenka.cloud');
  });

  it('ローカル開発環境では localhost URL を返すべき', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const result = resolveApplicationPlaneEndpoint('my-tenant');
    expect(result).toBe('http://localhost:13001?tenant=my-tenant');
  });

  it('APPLICATION_PLANE_BASE_URL が NODE_ENV=production より優先されるべき', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('APPLICATION_PLANE_BASE_URL', 'https://custom.example.com');
    const result = resolveApplicationPlaneEndpoint('my-tenant');
    expect(result).toBe('https://custom.example.com?tenant=my-tenant');
  });

  it('slug に特殊文字がある場合はエンコードすべき', () => {
    const result = resolveApplicationPlaneEndpoint('my tenant&co');
    expect(result).toBe(
      'http://localhost:13001?tenant=my%20tenant%26co',
    );
  });
});

describe('ProvisioningManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mockUpdate.mockResolvedValue(mockTenant);
    mockUpdateProvisioningStatus.mockResolvedValue(mockTenant);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('プロビジョニング完了時に applicationPlaneEndpoint を設定すべき', async () => {
    const manager = new ProvisioningManager();

    await manager.provisionTenant(mockTenant);

    expect(mockUpdate).toHaveBeenCalledWith(mockTenant.id, {
      provisioningStatus: 'COMPLETED',
      applicationDeploymentStatus: 'DEPLOYED',
      applicationPlaneEndpoint: 'http://localhost:13001?tenant=test-tenant',
      status: 'ACTIVE',
    });
  });

  it('プロビジョニング完了時に APPLICATION_PLANE_BASE_URL からエンドポイントを解決すべき', async () => {
    vi.stubEnv('APPLICATION_PLANE_BASE_URL', 'https://app.tenka.cloud');
    const manager = new ProvisioningManager();

    await manager.provisionTenant(mockTenant);

    expect(mockUpdate).toHaveBeenCalledWith(mockTenant.id, {
      provisioningStatus: 'COMPLETED',
      applicationDeploymentStatus: 'DEPLOYED',
      applicationPlaneEndpoint: 'https://app.tenka.cloud?tenant=test-tenant',
      status: 'ACTIVE',
    });
  });

  it('プロビジョニング失敗時は FAILED ステータスに更新すべき', async () => {
    // 1st call: IN_PROGRESS update succeeds
    mockUpdateProvisioningStatus.mockResolvedValueOnce(undefined);
    // 2nd call: FAILED update succeeds
    mockUpdateProvisioningStatus.mockResolvedValueOnce(undefined);

    // Make createRealm throw to trigger failure path
    const { KeycloakProvisioner } = await import('./keycloak');
    const mockCreateRealm = vi
      .fn()
      .mockRejectedValue(new Error('Keycloak unavailable'));
    vi.mocked(KeycloakProvisioner).mockImplementation(
      () =>
        ({
          createRealm: mockCreateRealm,
        }) as unknown as InstanceType<typeof KeycloakProvisioner>,
    );

    const manager = new ProvisioningManager();
    await manager.provisionTenant(mockTenant);

    // First call sets IN_PROGRESS
    expect(mockUpdateProvisioningStatus).toHaveBeenCalledWith(
      mockTenant.id,
      'IN_PROGRESS',
    );
    // Second call sets FAILED after createRealm throws
    expect(mockUpdateProvisioningStatus).toHaveBeenCalledWith(
      mockTenant.id,
      'FAILED',
    );
  });
});
