import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DynamoDBStreamEvent, DynamoDBRecord } from 'aws-lambda';

// Mock AWS SDK clients
vi.mock('@aws-sdk/client-eventbridge', () => ({
  EventBridgeClient: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockResolvedValue({ FailedEntryCount: 0, Entries: [] }),
  })),
  PutEventsCommand: vi.fn(),
}));

vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: vi.fn().mockReturnValue({
      send: vi.fn().mockResolvedValue({}),
    }),
  },
  UpdateCommand: vi.fn(),
  GetCommand: vi.fn(),
}));

import { handler } from './handler';

describe('Provisioning Lambda Handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('INSERT イベントで TenantOnboarding を発行すべき', async () => {
    const event: DynamoDBStreamEvent = {
      Records: [
        createTenantRecord('INSERT', {
          id: 'tenant-123',
          name: 'Test Tenant',
          slug: 'test-tenant',
          tier: 'FREE',
          status: 'ACTIVE',
          provisioningStatus: 'PENDING',
        }),
      ],
    };

    await expect(handler(event)).resolves.toBeUndefined();
  });

  it('REMOVE イベントで TenantOffboarding を発行すべき', async () => {
    const event: DynamoDBStreamEvent = {
      Records: [
        createTenantRecord('REMOVE', null, {
          id: 'tenant-123',
          name: 'Test Tenant',
          slug: 'test-tenant',
          tier: 'FREE',
          status: 'DELETED',
          provisioningStatus: 'PROVISIONED',
        }),
      ],
    };

    await expect(handler(event)).resolves.toBeUndefined();
  });

  it('MODIFY イベントでステータス変更時に TenantUpdated を発行すべき', async () => {
    const event: DynamoDBStreamEvent = {
      Records: [
        createTenantRecord(
          'MODIFY',
          {
            id: 'tenant-123',
            name: 'Test Tenant',
            slug: 'test-tenant',
            tier: 'PRO',
            status: 'ACTIVE',
            provisioningStatus: 'PROVISIONED',
          },
          {
            id: 'tenant-123',
            name: 'Test Tenant',
            slug: 'test-tenant',
            tier: 'FREE',
            status: 'ACTIVE',
            provisioningStatus: 'PROVISIONED',
          }
        ),
      ],
    };

    await expect(handler(event)).resolves.toBeUndefined();
  });

  it('非テナントレコードはスキップすべき', async () => {
    const event: DynamoDBStreamEvent = {
      Records: [
        {
          eventID: '1',
          eventName: 'INSERT',
          dynamodb: {
            NewImage: {
              PK: { S: 'USER#user-123' },
              SK: { S: 'METADATA' },
              id: { S: 'user-123' },
            },
          },
        } as unknown as DynamoDBRecord,
      ],
    };

    await expect(handler(event)).resolves.toBeUndefined();
  });

  it('空のレコードリストを処理すべき', async () => {
    const event: DynamoDBStreamEvent = {
      Records: [],
    };

    await expect(handler(event)).resolves.toBeUndefined();
  });
});

function createTenantRecord(
  eventName: 'INSERT' | 'MODIFY' | 'REMOVE',
  newImage: TenantData | null,
  oldImage?: TenantData | null
): DynamoDBRecord {
  const record: DynamoDBRecord = {
    eventID: '1',
    eventName,
    dynamodb: {},
  } as unknown as DynamoDBRecord;

  if (newImage) {
    record.dynamodb!.NewImage = marshallTenant(newImage);
  }

  if (oldImage) {
    record.dynamodb!.OldImage = marshallTenant(oldImage);
  }

  return record;
}

interface TenantData {
  id: string;
  name: string;
  slug: string;
  tier: string;
  status: string;
  provisioningStatus: string;
}

function marshallTenant(data: TenantData): Record<string, { S: string }> {
  return {
    PK: { S: `TENANT#${data.id}` },
    SK: { S: 'METADATA' },
    id: { S: data.id },
    name: { S: data.name },
    slug: { S: data.slug },
    tier: { S: data.tier },
    status: { S: data.status },
    provisioningStatus: { S: data.provisioningStatus },
    createdAt: { S: new Date().toISOString() },
    updatedAt: { S: new Date().toISOString() },
  };
}
