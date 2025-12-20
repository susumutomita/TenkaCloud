import {
  PutCommand,
  GetCommand,
  UpdateCommand,
  QueryCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import { ulid } from 'ulid';
import { getDocClient, getTableName } from './client';
import type {
  Deployment,
  DeploymentItem,
  DeploymentHistory,
  DeploymentHistoryItem,
  CreateDeploymentInput,
  UpdateDeploymentInput,
  CreateDeploymentHistoryInput,
  DeploymentStatus,
} from './types';
import { EntityType } from './types';

// Key builders
const buildDeploymentPK = (id: string) => `DEPLOYMENT#${id}`;
const buildMetadataSK = () => 'METADATA';
const buildHistorySK = (timestamp: string, id: string) =>
  `HISTORY#${timestamp}#${id}`;
const buildTenantDeploymentGSI = (tenantId: string) =>
  `TENANT#${tenantId}#DEPLOYMENT`;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const buildStatusGSI = (status: DeploymentStatus) => `DEPLOYMENT#${status}`;

// Convert DynamoDB history item to domain object
function historyToDomain(item: DeploymentHistoryItem): DeploymentHistory {
  return {
    id: item.id,
    deploymentId: item.deploymentId,
    status: item.status,
    message: item.message,
    createdAt: new Date(item.CreatedAt),
  };
}

// Convert DynamoDB item to domain object
function toDomain(item: DeploymentItem): Deployment {
  return {
    id: item.id,
    tenantId: item.tenantId,
    tenantSlug: item.tenantSlug,
    namespace: item.namespace,
    serviceName: item.serviceName,
    image: item.image,
    version: item.version,
    replicas: item.replicas,
    status: item.status,
    type: item.type,
    previousImage: item.previousImage,
    errorMessage: item.errorMessage,
    startedAt: item.startedAt ? new Date(item.startedAt) : undefined,
    completedAt: item.completedAt ? new Date(item.completedAt) : undefined,
    createdAt: new Date(item.CreatedAt),
    updatedAt: new Date(item.UpdatedAt),
  };
}

export class DeploymentRepository {
  async create(input: CreateDeploymentInput): Promise<Deployment> {
    const client = getDocClient();
    const tableName = getTableName();
    const now = new Date().toISOString();
    const id = ulid();

    const item: DeploymentItem = {
      PK: buildDeploymentPK(id),
      SK: buildMetadataSK(),
      GSI1PK: buildTenantDeploymentGSI(input.tenantId),
      GSI1SK: now,
      EntityType: EntityType.DEPLOYMENT,
      CreatedAt: now,
      UpdatedAt: now,
      id,
      tenantId: input.tenantId,
      tenantSlug: input.tenantSlug,
      namespace: input.namespace,
      serviceName: input.serviceName,
      image: input.image,
      version: input.version,
      replicas: input.replicas ?? 1,
      status: 'PENDING',
      type: input.type ?? 'CREATE',
    };

    await client.send(
      new PutCommand({
        TableName: tableName,
        Item: item,
        ConditionExpression: 'attribute_not_exists(PK)',
      })
    );

    return toDomain(item);
  }

  async findById(id: string): Promise<Deployment | null> {
    const client = getDocClient();
    const tableName = getTableName();

    const result = await client.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          PK: buildDeploymentPK(id),
          SK: buildMetadataSK(),
        },
      })
    );

    if (!result.Item) {
      return null;
    }

    return toDomain(result.Item as DeploymentItem);
  }

  async listByTenant(
    tenantId: string,
    options?: {
      status?: DeploymentStatus;
      limit?: number;
      lastKey?: Record<string, unknown>;
    }
  ): Promise<{ deployments: Deployment[]; lastKey?: Record<string, unknown> }> {
    const client = getDocClient();
    const tableName = getTableName();

    let filterExpression: string | undefined;
    const expressionValues: Record<string, unknown> = {
      ':gsi1pk': buildTenantDeploymentGSI(tenantId),
    };

    if (options?.status) {
      filterExpression = '#status = :status';
      expressionValues[':status'] = options.status;
    }

    const result = await client.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :gsi1pk',
        FilterExpression: filterExpression,
        ExpressionAttributeValues: expressionValues,
        ExpressionAttributeNames: filterExpression
          ? { '#status': 'status' }
          : undefined,
        Limit: options?.limit ?? 50,
        ExclusiveStartKey: options?.lastKey,
        ScanIndexForward: false,
      })
    );

    const deployments = (result.Items ?? []).map((item) =>
      toDomain(item as DeploymentItem)
    );

    return {
      deployments,
      lastKey: result.LastEvaluatedKey,
    };
  }

  async update(id: string, input: UpdateDeploymentInput): Promise<Deployment> {
    const client = getDocClient();
    const tableName = getTableName();
    const now = new Date().toISOString();

    const updateExpressions: string[] = ['#updatedAt = :updatedAt'];
    const expressionNames: Record<string, string> = {
      '#updatedAt': 'UpdatedAt',
    };
    const expressionValues: Record<string, unknown> = {
      ':updatedAt': now,
    };

    if (input.status !== undefined) {
      updateExpressions.push('#status = :status');
      expressionNames['#status'] = 'status';
      expressionValues[':status'] = input.status;
    }

    if (input.errorMessage !== undefined) {
      updateExpressions.push('#errorMessage = :errorMessage');
      expressionNames['#errorMessage'] = 'errorMessage';
      expressionValues[':errorMessage'] = input.errorMessage;
    }

    if (input.startedAt !== undefined) {
      updateExpressions.push('#startedAt = :startedAt');
      expressionNames['#startedAt'] = 'startedAt';
      expressionValues[':startedAt'] = input.startedAt.toISOString();
    }

    if (input.completedAt !== undefined) {
      updateExpressions.push('#completedAt = :completedAt');
      expressionNames['#completedAt'] = 'completedAt';
      expressionValues[':completedAt'] = input.completedAt.toISOString();
    }

    const result = await client.send(
      new UpdateCommand({
        TableName: tableName,
        Key: {
          PK: buildDeploymentPK(id),
          SK: buildMetadataSK(),
        },
        UpdateExpression: `SET ${updateExpressions.join(', ')}`,
        ExpressionAttributeNames: expressionNames,
        ExpressionAttributeValues: expressionValues,
        ReturnValues: 'ALL_NEW',
        ConditionExpression: 'attribute_exists(PK)',
      })
    );

    return toDomain(result.Attributes as DeploymentItem);
  }

  async delete(id: string): Promise<void> {
    const client = getDocClient();
    const tableName = getTableName();

    await client.send(
      new DeleteCommand({
        TableName: tableName,
        Key: {
          PK: buildDeploymentPK(id),
          SK: buildMetadataSK(),
        },
      })
    );
  }

  async addHistory(
    input: CreateDeploymentHistoryInput
  ): Promise<DeploymentHistory> {
    const client = getDocClient();
    const tableName = getTableName();
    const now = new Date().toISOString();
    const id = ulid();

    const item: DeploymentHistoryItem = {
      PK: buildDeploymentPK(input.deploymentId),
      SK: buildHistorySK(now, id),
      EntityType: EntityType.DEPLOYMENT_HISTORY as 'DEPLOYMENT_HISTORY',
      CreatedAt: now,
      UpdatedAt: now,
      id,
      deploymentId: input.deploymentId,
      status: input.status,
      message: input.message,
    };

    await client.send(
      new PutCommand({
        TableName: tableName,
        Item: item,
      })
    );

    return historyToDomain(item);
  }

  async getHistory(deploymentId: string): Promise<DeploymentHistory[]> {
    const client = getDocClient();
    const tableName = getTableName();

    const result = await client.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
        ExpressionAttributeValues: {
          ':pk': buildDeploymentPK(deploymentId),
          ':skPrefix': 'HISTORY#',
        },
        ScanIndexForward: true, // 古い順に取得
      })
    );

    return (result.Items ?? []).map((item) =>
      historyToDomain(item as DeploymentHistoryItem)
    );
  }

  async countByTenant(
    tenantId: string,
    status?: DeploymentStatus
  ): Promise<number> {
    const client = getDocClient();
    const tableName = getTableName();

    let filterExpression: string | undefined;
    const expressionValues: Record<string, unknown> = {
      ':gsi1pk': buildTenantDeploymentGSI(tenantId),
    };

    if (status) {
      filterExpression = '#status = :status';
      expressionValues[':status'] = status;
    }

    const result = await client.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :gsi1pk',
        FilterExpression: filterExpression,
        ExpressionAttributeValues: expressionValues,
        ExpressionAttributeNames: filterExpression
          ? { '#status': 'status' }
          : undefined,
        Select: 'COUNT',
      })
    );

    return result.Count ?? 0;
  }
}
