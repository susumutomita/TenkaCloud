import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EventBridgeEvent, Context } from 'aws-lambda';

// Mock Auth0Provisioner
vi.mock('@tenkacloud/auth0', () => ({
  Auth0Provisioner: vi.fn().mockImplementation(() => ({
    createTenantOrganization: vi.fn().mockResolvedValue({
      organizationId: 'org_mock_test-tenant',
      organizationName: 'tenant-test-tenant',
    }),
  })),
}));

// Mock IAM Provisioner
vi.mock('./iam-provisioner', () => ({
  createTenantRole: vi.fn().mockResolvedValue({
    roleArn: 'arn:aws:iam::000000000000:role/tenkacloud-tenant-test-tenant',
    roleName: 'tenkacloud-tenant-test-tenant',
  }),
}));

// Mock CloudWatch Provisioner
vi.mock('./cloudwatch-provisioner', () => ({
  createTenantLogGroup: vi.fn().mockResolvedValue({
    logGroupName: '/tenkacloud/tenants/tenant-123',
    retentionDays: 30,
  }),
}));

// Mock AWS SDK clients
vi.mock('@aws-sdk/client-eventbridge', () => ({
  EventBridgeClient: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockResolvedValue({ FailedEntryCount: 0, Entries: [] }),
  })),
  PutEventsCommand: vi.fn(),
}));

// S3 用の共有モック（vi.mock() と同時にホイスティングされる）
const { mockS3Send } = vi.hoisted(() => ({
  mockS3Send: vi.fn().mockResolvedValue({}),
}));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({
    send: mockS3Send,
  })),
  PutObjectCommand: vi.fn().mockImplementation((input) => ({ input })),
  CreateBucketCommand: vi.fn().mockImplementation((input) => ({ input })),
  HeadBucketCommand: vi.fn().mockImplementation((input) => ({ input })),
}));

import { handler } from './handler';
import { createTenantRole } from './iam-provisioner';
import { createTenantLogGroup } from './cloudwatch-provisioner';

describe('Tenant Provisioner Lambda Handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // S3 モックをデフォルト動作にリセット
    mockS3Send.mockResolvedValue({});
  });

  const mockContext: Context = {
    callbackWaitsForEmptyEventLoop: false,
    functionName: 'tenant-provisioner',
    functionVersion: '1',
    invokedFunctionArn:
      'arn:aws:lambda:ap-northeast-1:000000000000:function:tenant-provisioner',
    memoryLimitInMB: '128',
    awsRequestId: 'test-request-id',
    logGroupName: '/aws/lambda/tenant-provisioner',
    logStreamName: 'test-stream',
    getRemainingTimeInMillis: () => 30000,
    done: () => {},
    fail: () => {},
    succeed: () => {},
  };

  function createTenantOnboardingEvent(
    overrides: Partial<{
      tenantId: string;
      tenantSlug: string;
      tenantTier: 'FREE' | 'PRO' | 'ENTERPRISE';
      tenantName: string;
    }> = {}
  ): EventBridgeEvent<'TenantOnboarding', Record<string, unknown>> {
    const tenantId = overrides.tenantId ?? 'tenant-123';
    const tenantSlug = overrides.tenantSlug ?? 'test-tenant';
    const tenantTier = overrides.tenantTier ?? 'FREE';
    const tenantName = overrides.tenantName ?? 'Test Tenant';

    return {
      version: '0',
      id: 'test-event-id',
      'detail-type': 'TenantOnboarding',
      source: 'tenkacloud.control-plane',
      account: '000000000000',
      time: new Date().toISOString(),
      region: 'ap-northeast-1',
      resources: [],
      detail: {
        tenantId,
        tenantSlug,
        tenantTier,
        eventType: 'TenantOnboarding',
        timestamp: new Date().toISOString(),
        details: {
          id: tenantId,
          name: tenantName,
          slug: tenantSlug,
          tier: tenantTier,
          status: 'ACTIVE',
        },
      },
    };
  }

  it('FREE tier テナントのプロビジョニングを成功すべき', async () => {
    const event = createTenantOnboardingEvent({
      tenantId: 'tenant-free-123',
      tenantSlug: 'free-tenant',
      tenantTier: 'FREE',
    });

    await expect(handler(event as never, mockContext)).resolves.toBeUndefined();

    // Auth0, IAM, CloudWatch が呼ばれたことを確認
    expect(createTenantRole).toHaveBeenCalledWith(
      'tenant-free-123',
      'free-tenant',
      'FREE',
      'tenkacloud-data'
    );
    expect(createTenantLogGroup).toHaveBeenCalledWith(
      'tenant-free-123',
      'free-tenant',
      'FREE'
    );
  });

  it('PRO tier テナントのプロビジョニングを成功すべき', async () => {
    const event = createTenantOnboardingEvent({
      tenantId: 'tenant-pro-123',
      tenantSlug: 'pro-tenant',
      tenantTier: 'PRO',
    });

    await expect(handler(event as never, mockContext)).resolves.toBeUndefined();

    expect(createTenantRole).toHaveBeenCalledWith(
      'tenant-pro-123',
      'pro-tenant',
      'PRO',
      'tenkacloud-data'
    );
  });

  it('ENTERPRISE tier テナントでは Silo モデルを使用すべき', async () => {
    const { HeadBucketCommand } = await import('@aws-sdk/client-s3');

    // Mock S3 HeadBucket to throw NotFound
    mockS3Send.mockImplementation((command) => {
      if (command instanceof HeadBucketCommand) {
        const error = new Error('Not Found');
        (error as Error & { name: string }).name = 'NotFound';
        throw error;
      }
      return Promise.resolve({});
    });

    const event = createTenantOnboardingEvent({
      tenantId: 'tenant-ent-123',
      tenantSlug: 'enterprise-tenant',
      tenantTier: 'ENTERPRISE',
    });

    await expect(handler(event as never, mockContext)).resolves.toBeUndefined();

    expect(createTenantRole).toHaveBeenCalledWith(
      'tenant-ent-123',
      'enterprise-tenant',
      'ENTERPRISE',
      'tenkacloud-data'
    );
  });

  it('IAM プロビジョニング失敗時にエラーをスローすべき', async () => {
    vi.mocked(createTenantRole).mockRejectedValueOnce(
      new Error('IAM Role creation failed')
    );

    const event = createTenantOnboardingEvent();

    await expect(handler(event as never, mockContext)).rejects.toThrow(
      'IAM Role creation failed'
    );
  });

  it('CloudWatch プロビジョニング失敗時にエラーをスローすべき', async () => {
    vi.mocked(createTenantLogGroup).mockRejectedValueOnce(
      new Error('Log Group creation failed')
    );

    const event = createTenantOnboardingEvent();

    await expect(handler(event as never, mockContext)).rejects.toThrow(
      'Log Group creation failed'
    );
  });

  it('S3 プロビジョニング失敗時にエラーをスローすべき', async () => {
    mockS3Send.mockRejectedValue(new Error('S3 bucket creation failed'));

    const event = createTenantOnboardingEvent();

    await expect(handler(event as never, mockContext)).rejects.toThrow(
      'S3 bucket creation failed'
    );
  });
});
