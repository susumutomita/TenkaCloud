import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tenant } from '@tenkacloud/dynamodb';

const mockSend = vi.hoisted(() => vi.fn().mockResolvedValue({ FailedEntryCount: 0 }));
const mockPutEventsCommand = vi.hoisted(() =>
  vi.fn().mockImplementation((input) => ({ input })),
);

vi.mock('@aws-sdk/client-eventbridge', () => ({
  EventBridgeClient: vi.fn().mockImplementation(() => ({
    send: mockSend,
  })),
  PutEventsCommand: mockPutEventsCommand,
}));

import { TenantProvisioningPublisher } from './publisher';

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

describe('TenantProvisioningPublisher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockResolvedValue({ FailedEntryCount: 0 });
  });

  it('TenantOnboarding イベントを発行すべき', async () => {
    const publisher = new TenantProvisioningPublisher();

    await expect(publisher.publishTenantOnboarding(mockTenant)).resolves.toBeUndefined();

    expect(mockPutEventsCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        Entries: [
          expect.objectContaining({
            EventBusName: 'default',
            Source: 'tenkacloud.control-plane',
            DetailType: 'TenantOnboarding',
          }),
        ],
      }),
    );

    const commandInput = mockPutEventsCommand.mock.calls[0]?.[0];
    const detail = JSON.parse(commandInput.Entries[0].Detail);

    expect(detail).toMatchObject({
      tenantId: mockTenant.id,
      tenantName: mockTenant.name,
      slug: mockTenant.slug,
      tier: mockTenant.tier,
      adminEmail: mockTenant.adminEmail,
      isolationModel: mockTenant.isolationModel,
      region: mockTenant.region,
    });
  });

  it('EventBridge が失敗した場合はエラーを投げるべき', async () => {
    const publisher = new TenantProvisioningPublisher();
    mockSend.mockResolvedValue({
      FailedEntryCount: 1,
      Entries: [
        {
          ErrorCode: 'InternalFailure',
          ErrorMessage: 'event bus unavailable',
        },
      ],
    });

    await expect(publisher.publishTenantOnboarding(mockTenant)).rejects.toThrow(
      'Failed to publish tenant onboarding event: InternalFailure - event bus unavailable',
    );
  });
});
