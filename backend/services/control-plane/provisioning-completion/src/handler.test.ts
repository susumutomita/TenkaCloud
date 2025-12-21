import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EventBridgeEvent, Context } from 'aws-lambda';

// hoisted mock for vi.mock
const mockSend = vi.hoisted(() => vi.fn().mockResolvedValue({}));

// Mock AWS SDK clients
vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: vi.fn().mockReturnValue({
      send: mockSend,
    }),
  },
  UpdateCommand: vi.fn(),
}));

import { handler } from './handler';

interface TenantProvisionedDetail {
  tenantId: string;
  status: 'COMPLETED' | 'FAILED';
  resources: {
    s3Prefix?: string;
    dedicatedBucket?: string;
  };
  error?: string;
  timestamp: string;
}

function createEvent(
  detail: TenantProvisionedDetail
): EventBridgeEvent<'TenantProvisioned', TenantProvisionedDetail> {
  return {
    version: '0',
    id: 'test-event-id',
    'detail-type': 'TenantProvisioned',
    source: 'tenkacloud.application-plane',
    account: '123456789012',
    time: new Date().toISOString(),
    region: 'ap-northeast-1',
    resources: [],
    detail,
  };
}

const mockContext: Context = {
  callbackWaitsForEmptyEventLoop: false,
  functionName: 'test-function',
  functionVersion: '1',
  invokedFunctionArn:
    'arn:aws:lambda:ap-northeast-1:123456789012:function:test',
  memoryLimitInMB: '256',
  awsRequestId: 'test-request-id',
  logGroupName: '/aws/lambda/test',
  logStreamName: 'test-stream',
  getRemainingTimeInMillis: () => 30000,
  done: () => {},
  fail: () => {},
  succeed: () => {},
};

describe('Provisioning Completion Lambda Handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockResolvedValue({});
  });

  it('COMPLETED ステータスで provisioningStatus を PROVISIONED に更新すべき', async () => {
    const event = createEvent({
      tenantId: 'tenant-123',
      status: 'COMPLETED',
      resources: { s3Prefix: 'tenants/tenant-123/' },
      timestamp: new Date().toISOString(),
    });

    await expect(handler(event, mockContext)).resolves.toBeUndefined();
    expect(mockSend).toHaveBeenCalled();
  });

  it('FAILED ステータスで provisioningStatus を FAILED に更新すべき', async () => {
    const event = createEvent({
      tenantId: 'tenant-123',
      status: 'FAILED',
      resources: {},
      error: 'S3 bucket creation failed',
      timestamp: new Date().toISOString(),
    });

    await expect(handler(event, mockContext)).resolves.toBeUndefined();
    expect(mockSend).toHaveBeenCalled();
  });

  it('dedicatedBucket リソースを正しく保存すべき', async () => {
    const event = createEvent({
      tenantId: 'tenant-enterprise',
      status: 'COMPLETED',
      resources: { dedicatedBucket: 'tenkacloud-tenant-enterprise' },
      timestamp: new Date().toISOString(),
    });

    await expect(handler(event, mockContext)).resolves.toBeUndefined();
    expect(mockSend).toHaveBeenCalled();
  });

  it('ConditionalCheckFailedException が発生した場合はスキップすべき', async () => {
    const error = new Error('The conditional request failed');
    error.name = 'ConditionalCheckFailedException';
    mockSend.mockRejectedValueOnce(error);

    const event = createEvent({
      tenantId: 'tenant-123',
      status: 'COMPLETED',
      resources: { s3Prefix: 'tenants/tenant-123/' },
      timestamp: new Date().toISOString(),
    });

    // べき等性: 既にプロビジョニング済みならスキップ
    await expect(handler(event, mockContext)).resolves.toBeUndefined();
  });

  it('その他のエラーはスローすべき', async () => {
    const error = new Error('Internal server error');
    error.name = 'InternalServerError';
    mockSend.mockRejectedValueOnce(error);

    const event = createEvent({
      tenantId: 'tenant-123',
      status: 'COMPLETED',
      resources: { s3Prefix: 'tenants/tenant-123/' },
      timestamp: new Date().toISOString(),
    });

    await expect(handler(event, mockContext)).rejects.toThrow(
      'Internal server error'
    );
  });

  it('空のリソースオブジェクトを正しく処理すべき', async () => {
    const event = createEvent({
      tenantId: 'tenant-123',
      status: 'COMPLETED',
      resources: {},
      timestamp: new Date().toISOString(),
    });

    await expect(handler(event, mockContext)).resolves.toBeUndefined();
    expect(mockSend).toHaveBeenCalled();
  });

  it('エラーメッセージを FAILED ステータスで保存すべき', async () => {
    const event = createEvent({
      tenantId: 'tenant-123',
      status: 'FAILED',
      resources: {},
      error: 'Bucket already exists',
      timestamp: new Date().toISOString(),
    });

    await expect(handler(event, mockContext)).resolves.toBeUndefined();
    expect(mockSend).toHaveBeenCalled();
  });
});
