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
  AuditLog,
  AuditLogItem,
  SystemSetting,
  SystemSettingItem,
  ServiceHealth,
  ServiceHealthItem,
  CreateAuditLogInput,
  SetSystemSettingInput,
  UpdateServiceHealthInput,
  AuditAction,
  AuditResourceType,
} from './types';
import { EntityType } from './types';

// Key builders
const buildAuditPK = (tenantId: string) => `AUDIT#${tenantId || 'SYSTEM'}`;
const buildAuditSK = (timestamp: string, id: string) =>
  `LOG#${timestamp}#${id}`;
const buildSettingPK = () => 'SYSTEM#SETTING';
const buildSettingSK = (key: string) => `KEY#${key}`;
const buildHealthPK = () => 'SYSTEM#HEALTH';
const buildHealthSK = (serviceName: string) => `SERVICE#${serviceName}`;

// Convert DynamoDB items to domain objects
function toAuditLog(item: AuditLogItem): AuditLog {
  return {
    id: item.id,
    tenantId: item.tenantId,
    userId: item.userId,
    action: item.action,
    resourceType: item.resourceType,
    resourceId: item.resourceId,
    details: item.details,
    ipAddress: item.ipAddress,
    userAgent: item.userAgent,
    createdAt: new Date(item.CreatedAt),
  };
}

function toSystemSetting(item: SystemSettingItem): SystemSetting {
  return {
    key: item.key,
    value: item.value,
    category: item.category,
    updatedBy: item.updatedBy,
    updatedAt: new Date(item.UpdatedAt),
  };
}

function toServiceHealth(item: ServiceHealthItem): ServiceHealth {
  return {
    id: item.id,
    serviceName: item.serviceName,
    status: item.status,
    lastCheck: new Date(item.lastCheck),
    details: item.details,
  };
}

export class AuditLogRepository {
  async create(input: CreateAuditLogInput): Promise<AuditLog> {
    const client = getDocClient();
    const tableName = getTableName();
    const now = new Date().toISOString();
    const id = ulid();

    const item: AuditLogItem = {
      PK: buildAuditPK(input.tenantId ?? ''),
      SK: buildAuditSK(now, id),
      GSI1PK: input.userId ? `USER#${input.userId}#AUDIT` : undefined,
      GSI1SK: now,
      EntityType: EntityType.AUDIT_LOG,
      CreatedAt: now,
      UpdatedAt: now,
      id,
      tenantId: input.tenantId,
      userId: input.userId,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      details: input.details,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    };

    await client.send(
      new PutCommand({
        TableName: tableName,
        Item: item,
      })
    );

    return toAuditLog(item);
  }

  async listByTenant(
    tenantId: string,
    options?: {
      action?: AuditAction;
      resourceType?: AuditResourceType;
      limit?: number;
      lastKey?: Record<string, unknown>;
    }
  ): Promise<{ logs: AuditLog[]; lastKey?: Record<string, unknown> }> {
    const client = getDocClient();
    const tableName = getTableName();

    let filterExpression: string | undefined;
    const filterParts: string[] = [];
    const expressionValues: Record<string, unknown> = {
      ':pk': buildAuditPK(tenantId),
    };
    const expressionNames: Record<string, string> = {};

    if (options?.action) {
      filterParts.push('#action = :action');
      expressionNames['#action'] = 'action';
      expressionValues[':action'] = options.action;
    }

    if (options?.resourceType) {
      filterParts.push('#resourceType = :resourceType');
      expressionNames['#resourceType'] = 'resourceType';
      expressionValues[':resourceType'] = options.resourceType;
    }

    if (filterParts.length > 0) {
      filterExpression = filterParts.join(' AND ');
    }

    const result = await client.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'PK = :pk',
        FilterExpression: filterExpression,
        ExpressionAttributeValues: expressionValues,
        ExpressionAttributeNames:
          Object.keys(expressionNames).length > 0 ? expressionNames : undefined,
        Limit: options?.limit ?? 50,
        ExclusiveStartKey: options?.lastKey,
        ScanIndexForward: false,
      })
    );

    const logs = (result.Items ?? []).map((item) =>
      toAuditLog(item as AuditLogItem)
    );

    return {
      logs,
      lastKey: result.LastEvaluatedKey,
    };
  }

  async listByUser(
    userId: string,
    options?: {
      limit?: number;
      lastKey?: Record<string, unknown>;
    }
  ): Promise<{ logs: AuditLog[]; lastKey?: Record<string, unknown> }> {
    const client = getDocClient();
    const tableName = getTableName();

    const result = await client.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :gsi1pk',
        ExpressionAttributeValues: {
          ':gsi1pk': `USER#${userId}#AUDIT`,
        },
        Limit: options?.limit ?? 50,
        ExclusiveStartKey: options?.lastKey,
        ScanIndexForward: false,
      })
    );

    const logs = (result.Items ?? []).map((item) =>
      toAuditLog(item as AuditLogItem)
    );

    return {
      logs,
      lastKey: result.LastEvaluatedKey,
    };
  }
}

export class SystemSettingRepository {
  async set(input: SetSystemSettingInput): Promise<SystemSetting> {
    const client = getDocClient();
    const tableName = getTableName();
    const now = new Date().toISOString();

    const item: SystemSettingItem = {
      PK: buildSettingPK(),
      SK: buildSettingSK(input.key),
      EntityType: EntityType.SYSTEM_SETTING,
      CreatedAt: now,
      UpdatedAt: now,
      key: input.key,
      value: input.value,
      category: input.category,
      updatedBy: input.updatedBy,
    };

    await client.send(
      new PutCommand({
        TableName: tableName,
        Item: item,
      })
    );

    return toSystemSetting(item);
  }

  async get(key: string): Promise<SystemSetting | null> {
    const client = getDocClient();
    const tableName = getTableName();

    const result = await client.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          PK: buildSettingPK(),
          SK: buildSettingSK(key),
        },
      })
    );

    if (!result.Item) {
      return null;
    }

    return toSystemSetting(result.Item as SystemSettingItem);
  }

  async listByCategory(category: string): Promise<SystemSetting[]> {
    const client = getDocClient();
    const tableName = getTableName();

    const result = await client.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'PK = :pk',
        FilterExpression: '#category = :category',
        ExpressionAttributeValues: {
          ':pk': buildSettingPK(),
          ':category': category,
        },
        ExpressionAttributeNames: {
          '#category': 'category',
        },
      })
    );

    return (result.Items ?? []).map((item) =>
      toSystemSetting(item as SystemSettingItem)
    );
  }

  async listAll(): Promise<SystemSetting[]> {
    const client = getDocClient();
    const tableName = getTableName();

    const result = await client.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: {
          ':pk': buildSettingPK(),
        },
      })
    );

    return (result.Items ?? []).map((item) =>
      toSystemSetting(item as SystemSettingItem)
    );
  }

  async delete(key: string): Promise<void> {
    const client = getDocClient();
    const tableName = getTableName();

    await client.send(
      new DeleteCommand({
        TableName: tableName,
        Key: {
          PK: buildSettingPK(),
          SK: buildSettingSK(key),
        },
      })
    );
  }
}

export class ServiceHealthRepository {
  async upsert(input: UpdateServiceHealthInput): Promise<ServiceHealth> {
    const client = getDocClient();
    const tableName = getTableName();
    const now = new Date().toISOString();
    const id = ulid();

    const item: ServiceHealthItem = {
      PK: buildHealthPK(),
      SK: buildHealthSK(input.serviceName),
      EntityType: EntityType.SERVICE_HEALTH,
      CreatedAt: now,
      UpdatedAt: now,
      id,
      serviceName: input.serviceName,
      status: input.status,
      lastCheck: now,
      details: input.details,
    };

    await client.send(
      new PutCommand({
        TableName: tableName,
        Item: item,
      })
    );

    return toServiceHealth(item);
  }

  async get(serviceName: string): Promise<ServiceHealth | null> {
    const client = getDocClient();
    const tableName = getTableName();

    const result = await client.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          PK: buildHealthPK(),
          SK: buildHealthSK(serviceName),
        },
      })
    );

    if (!result.Item) {
      return null;
    }

    return toServiceHealth(result.Item as ServiceHealthItem);
  }

  async listAll(): Promise<ServiceHealth[]> {
    const client = getDocClient();
    const tableName = getTableName();

    const result = await client.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: {
          ':pk': buildHealthPK(),
        },
      })
    );

    return (result.Items ?? []).map((item) =>
      toServiceHealth(item as ServiceHealthItem)
    );
  }
}
