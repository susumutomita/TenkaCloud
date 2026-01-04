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
  Tenant,
  TenantItem,
  CreateTenantInput,
  UpdateTenantInput,
  TenantStatus,
  ProvisioningStatus,
} from './types';
import { EntityType, IsolationModel, ComputeType } from './types';

// Key builders
const buildTenantPK = (id: string) => `TENANT#${id}`;
const buildMetadataSK = () => 'METADATA';

// Convert DynamoDB item to domain object
function toDomain(item: TenantItem): Tenant {
  return {
    id: item.id,
    name: item.name,
    slug: item.slug,
    status: item.status,
    tier: item.tier,
    adminEmail: item.adminEmail,
    adminName: item.adminName,
    region: item.region,
    isolationModel: item.isolationModel,
    computeType: item.computeType,
    provisioningStatus: item.provisioningStatus,
    auth0OrgId: item.auth0OrgId,
    createdAt: new Date(item.CreatedAt),
    updatedAt: new Date(item.UpdatedAt),
  };
}

export class TenantRepository {
  async create(input: CreateTenantInput): Promise<Tenant> {
    const client = getDocClient();
    const tableName = getTableName();
    const now = new Date().toISOString();
    const id = ulid();

    const item: TenantItem = {
      PK: buildTenantPK(id),
      SK: buildMetadataSK(),
      GSI1PK: `SLUG#${input.slug}`,
      GSI1SK: buildMetadataSK(),
      EntityType: EntityType.TENANT,
      CreatedAt: now,
      UpdatedAt: now,
      id,
      name: input.name,
      slug: input.slug,
      status: 'ACTIVE',
      tier: input.tier ?? 'FREE',
      adminEmail: input.adminEmail,
      adminName: input.adminName,
      region: input.region ?? 'ap-northeast-1',
      isolationModel: input.isolationModel ?? IsolationModel.POOL,
      computeType: input.computeType ?? ComputeType.SERVERLESS,
      provisioningStatus: 'PENDING',
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

  async findById(id: string): Promise<Tenant | null> {
    const client = getDocClient();
    const tableName = getTableName();

    const result = await client.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          PK: buildTenantPK(id),
          SK: buildMetadataSK(),
        },
      })
    );

    if (!result.Item) {
      return null;
    }

    return toDomain(result.Item as TenantItem);
  }

  async findBySlug(slug: string): Promise<Tenant | null> {
    const client = getDocClient();
    const tableName = getTableName();

    const result = await client.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk AND GSI1SK = :sk',
        ExpressionAttributeValues: {
          ':pk': `SLUG#${slug}`,
          ':sk': buildMetadataSK(),
        },
        Limit: 1,
      })
    );

    if (!result.Items || result.Items.length === 0) {
      return null;
    }

    return toDomain(result.Items[0] as TenantItem);
  }

  async list(options?: {
    status?: TenantStatus;
    limit?: number;
    lastKey?: Record<string, unknown>;
  }): Promise<{ tenants: Tenant[]; lastKey?: Record<string, unknown> }> {
    const client = getDocClient();
    const tableName = getTableName();

    let filterExpression: string | undefined;
    const expressionValues: Record<string, unknown> = {
      ':entityType': EntityType.TENANT,
    };

    if (options?.status) {
      filterExpression = '#status = :status';
      expressionValues[':status'] = options.status;
    }

    const result = await client.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: 'GSI2',
        KeyConditionExpression: 'EntityType = :entityType',
        FilterExpression: filterExpression,
        ExpressionAttributeValues: expressionValues,
        ExpressionAttributeNames: filterExpression
          ? { '#status': 'status' }
          : undefined,
        Limit: options?.limit ?? 50,
        ExclusiveStartKey: options?.lastKey,
        ScanIndexForward: false, // Newest first
      })
    );

    const tenants = (result.Items ?? []).map((item) =>
      toDomain(item as TenantItem)
    );

    return {
      tenants,
      lastKey: result.LastEvaluatedKey,
    };
  }

  async update(id: string, input: UpdateTenantInput): Promise<Tenant> {
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

    if (input.name !== undefined) {
      updateExpressions.push('#name = :name');
      expressionNames['#name'] = 'name';
      expressionValues[':name'] = input.name;
    }

    if (input.status !== undefined) {
      updateExpressions.push('#status = :status');
      expressionNames['#status'] = 'status';
      expressionValues[':status'] = input.status;
    }

    if (input.tier !== undefined) {
      updateExpressions.push('#tier = :tier');
      expressionNames['#tier'] = 'tier';
      expressionValues[':tier'] = input.tier;
    }

    if (input.isolationModel !== undefined) {
      updateExpressions.push('#isolationModel = :isolationModel');
      expressionNames['#isolationModel'] = 'isolationModel';
      expressionValues[':isolationModel'] = input.isolationModel;
    }

    if (input.provisioningStatus !== undefined) {
      updateExpressions.push('#provisioningStatus = :provisioningStatus');
      expressionNames['#provisioningStatus'] = 'provisioningStatus';
      expressionValues[':provisioningStatus'] = input.provisioningStatus;
    }

    if (input.auth0OrgId !== undefined) {
      updateExpressions.push('#auth0OrgId = :auth0OrgId');
      expressionNames['#auth0OrgId'] = 'auth0OrgId';
      expressionValues[':auth0OrgId'] = input.auth0OrgId;
    }

    const result = await client.send(
      new UpdateCommand({
        TableName: tableName,
        Key: {
          PK: buildTenantPK(id),
          SK: buildMetadataSK(),
        },
        UpdateExpression: `SET ${updateExpressions.join(', ')}`,
        ExpressionAttributeNames: expressionNames,
        ExpressionAttributeValues: expressionValues,
        ReturnValues: 'ALL_NEW',
        ConditionExpression: 'attribute_exists(PK)',
      })
    );

    return toDomain(result.Attributes as TenantItem);
  }

  async updateProvisioningStatus(
    id: string,
    status: ProvisioningStatus,
    auth0OrgId?: string
  ): Promise<Tenant> {
    return this.update(id, {
      provisioningStatus: status,
      auth0OrgId,
    });
  }

  async delete(id: string): Promise<void> {
    const client = getDocClient();
    const tableName = getTableName();

    await client.send(
      new DeleteCommand({
        TableName: tableName,
        Key: {
          PK: buildTenantPK(id),
          SK: buildMetadataSK(),
        },
      })
    );
  }

  async count(): Promise<number> {
    const client = getDocClient();
    const tableName = getTableName();

    const result = await client.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: 'GSI2',
        KeyConditionExpression: 'EntityType = :entityType',
        ExpressionAttributeValues: {
          ':entityType': EntityType.TENANT,
        },
        Select: 'COUNT',
      })
    );

    return result.Count ?? 0;
  }
}
