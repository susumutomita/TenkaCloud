/**
 * Provisioning Lambda Handler
 *
 * Processes DynamoDB Stream events for tenant lifecycle management.
 * Publishes events to EventBridge for downstream processing.
 *
 * Flow:
 * 1. DynamoDB Stream triggers this Lambda on TENANT# changes
 * 2. Determines event type (INSERT/MODIFY/REMOVE)
 * 3. Publishes to EventBridge (TenantOnboarding/TenantUpdated/TenantOffboarding)
 * 4. Updates tenant provisioning status in DynamoDB
 */

import type { DynamoDBStreamEvent, DynamoDBRecord } from 'aws-lambda';
import {
  EventBridgeClient,
  PutEventsCommand,
} from '@aws-sdk/client-eventbridge';
import { DynamoDBClient, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import {
  EventDetailType,
  EventSource,
  type TenantOnboardingDetail,
} from '@tenkacloud/events';

const eventBridge = new EventBridgeClient({
  ...(process.env.AWS_ENDPOINT_URL
    ? { endpoint: process.env.AWS_ENDPOINT_URL }
    : {}),
});
const dynamoClient = new DynamoDBClient({
  ...(process.env.DYNAMODB_ENDPOINT
    ? { endpoint: process.env.DYNAMODB_ENDPOINT }
    : {}),
});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME ?? 'default';
const DYNAMODB_TABLE = process.env.DYNAMODB_TABLE ?? 'TenkaCloud';

interface TenantRecord {
  PK: string;
  SK: string;
  id: string;
  name: string;
  slug: string;
  adminEmail: string;
  tier: 'FREE' | 'PRO' | 'ENTERPRISE';
  status: 'ACTIVE' | 'SUSPENDED' | 'DELETED';
  isolationModel: 'POOL' | 'SILO';
  region: string;
  provisioningStatus: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
  auth0OrganizationId?: string;
  createdAt: string;
  updatedAt: string;
}

type TenantEventType =
  | 'TenantOnboarding'
  | 'TenantUpdated'
  | 'TenantOffboarding';

interface TenantLifecycleEvent {
  tenantId: string;
  tenantSlug: string;
  tenantTier: string;
  eventType: TenantEventType;
  timestamp: string;
  details: Partial<TenantRecord>;
}

export async function handler(event: DynamoDBStreamEvent): Promise<void> {
  console.log('Processing DynamoDB Stream event', {
    recordCount: event.Records.length,
  });

  for (const record of event.Records) {
    try {
      await processRecord(record);
    } catch (error) {
      console.error('Error processing record', {
        eventId: record.eventID,
        error: error instanceof Error ? error.message : String(error),
      });
      // Continue processing other records
    }
  }
}

async function processRecord(record: DynamoDBRecord): Promise<void> {
  const eventName = record.eventName;

  if (!eventName || !record.dynamodb) {
    console.log('Skipping record: missing eventName or dynamodb data');
    return;
  }

  // Extract tenant data from the record
  const newImage = record.dynamodb.NewImage
    ? (unmarshall(
        record.dynamodb.NewImage as Record<string, AttributeValue>
      ) as TenantRecord)
    : null;
  const oldImage = record.dynamodb.OldImage
    ? (unmarshall(
        record.dynamodb.OldImage as Record<string, AttributeValue>
      ) as TenantRecord)
    : null;

  // Only process TENANT# records with SK = METADATA
  const pk = newImage?.PK ?? oldImage?.PK;
  const sk = newImage?.SK ?? oldImage?.SK;

  if (!pk?.startsWith('TENANT#') || sk !== 'METADATA') {
    console.log('Skipping non-tenant record', { pk, sk });
    return;
  }

  const tenantId = pk.replace('TENANT#', '');
  let eventType: TenantEventType;

  switch (eventName) {
    case 'INSERT':
      eventType = 'TenantOnboarding';
      await updateProvisioningStatus(tenantId, 'IN_PROGRESS', 'PENDING');
      break;
    case 'MODIFY':
      // Check if this is a status change that requires action
      if (oldImage?.status !== newImage?.status) {
        if (newImage?.status === 'DELETED') {
          eventType = 'TenantOffboarding';
        } else {
          eventType = 'TenantUpdated';
        }
      } else if (oldImage?.tier !== newImage?.tier) {
        eventType = 'TenantUpdated';
      } else {
        console.log('Skipping MODIFY: no actionable changes');
        return;
      }
      break;
    case 'REMOVE':
      eventType = 'TenantOffboarding';
      break;
    default:
      console.log('Skipping unknown event type', { eventName });
      return;
  }

  const tenantData = newImage ?? oldImage;
  if (!tenantData) {
    console.error('No tenant data available');
    return;
  }

  const eventDetail =
    eventType === EventDetailType.TENANT_ONBOARDING
      ? ({
          tenantId,
          tenantName: tenantData.name,
          slug: tenantData.slug,
          tier: tenantData.tier,
          adminEmail: tenantData.adminEmail,
          isolationModel: tenantData.isolationModel,
          region: tenantData.region,
          timestamp: new Date().toISOString(),
        } satisfies TenantOnboardingDetail)
      : ({
          tenantId,
          tenantSlug: tenantData.slug,
          tenantTier: tenantData.tier,
          eventType,
          timestamp: new Date().toISOString(),
          details: {
            id: tenantData.id,
            name: tenantData.name,
            slug: tenantData.slug,
            tier: tenantData.tier,
            status: tenantData.status,
            auth0OrganizationId: tenantData.auth0OrganizationId,
          },
        } satisfies TenantLifecycleEvent);

  await publishEvent(eventType, eventDetail);

  // Log without sensitive data (auth0OrganizationId)
  console.log('Published tenant event', {
    tenantId,
    eventType,
    tier: tenantData.tier,
    status: tenantData.status,
  });
}

async function publishEvent(
  detailType: TenantEventType,
  detail: Record<string, unknown>
): Promise<void> {
  const command = new PutEventsCommand({
    Entries: [
      {
        EventBusName: EVENT_BUS_NAME,
        Source: EventSource.CONTROL_PLANE,
        DetailType: detailType,
        Detail: JSON.stringify(detail),
      },
    ],
  });

  const response = await eventBridge.send(command);

  if (response.FailedEntryCount && response.FailedEntryCount > 0) {
    const failedEntry = response.Entries?.find((e) => e.ErrorCode);
    throw new Error(
      `Failed to publish event: ${failedEntry?.ErrorCode} - ${failedEntry?.ErrorMessage}`
    );
  }
}

async function updateProvisioningStatus(
  tenantId: string,
  status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED',
  expectedCurrentStatus?: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED'
): Promise<void> {
  // Build condition expression to prevent race conditions
  // For PROVISIONING, we expect the current status to be PENDING
  const conditionParts = ['attribute_exists(PK)'];
  const expressionValues: Record<string, string> = {
    ':status': status,
    ':updatedAt': new Date().toISOString(),
  };

  if (expectedCurrentStatus) {
    conditionParts.push('provisioningStatus = :expectedStatus');
    expressionValues[':expectedStatus'] = expectedCurrentStatus;
  }

  const command = new UpdateCommand({
    TableName: DYNAMODB_TABLE,
    Key: {
      PK: `TENANT#${tenantId}`,
      SK: 'METADATA',
    },
    UpdateExpression:
      'SET provisioningStatus = :status, updatedAt = :updatedAt',
    ExpressionAttributeValues: expressionValues,
    ConditionExpression: conditionParts.join(' AND '),
  });

  try {
    // Workspace-level AWS SDK duplication makes UpdateCommand structurally
    // incompatible at compile time, although the runtime command shape is valid.
    await docClient.send(command as never);
    console.log('Updated provisioning status', { tenantId, status });
  } catch (error) {
    // Ignore if tenant was deleted or condition failed (at-least-once delivery)
    if (
      error instanceof Error &&
      error.name === 'ConditionalCheckFailedException'
    ) {
      console.log(
        'Tenant no longer exists or status already updated, skipping',
        { tenantId, status }
      );
      return;
    }
    throw error;
  }
}
