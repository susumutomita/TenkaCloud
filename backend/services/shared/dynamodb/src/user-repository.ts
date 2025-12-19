import {
  PutCommand,
  GetCommand,
  UpdateCommand,
  QueryCommand,
  DeleteCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { ulid } from 'ulid';
import { getDocClient, getTableName } from './client';
import type {
  User,
  UserItem,
  TenantUserItem,
  CreateUserInput,
  UpdateUserInput,
  UserRole,
  UserStatus,
} from './types';
import { EntityType } from './types';

// Key builders
const buildUserPK = (id: string) => `USER#${id}`;
const buildTenantPK = (tenantId: string) => `TENANT#${tenantId}`;
const buildUserSK = (id: string) => `USER#${id}`;
const buildMetadataSK = () => 'METADATA';

// Convert DynamoDB item to domain object
function toDomain(item: UserItem): User {
  return {
    id: item.id,
    tenantId: item.tenantId,
    email: item.email,
    name: item.name,
    role: item.role,
    status: item.status,
    auth0Id: item.auth0Id,
    createdAt: new Date(item.CreatedAt),
    updatedAt: new Date(item.UpdatedAt),
  };
}

export class UserRepository {
  async create(input: CreateUserInput): Promise<User> {
    const client = getDocClient();
    const tableName = getTableName();
    const now = new Date().toISOString();
    const id = ulid();

    // User metadata item
    const userItem: UserItem = {
      PK: buildUserPK(id),
      SK: buildMetadataSK(),
      GSI1PK: `EMAIL#${input.email}`,
      GSI1SK: buildMetadataSK(),
      EntityType: EntityType.USER,
      CreatedAt: now,
      UpdatedAt: now,
      id,
      tenantId: input.tenantId,
      email: input.email,
      name: input.name,
      role: input.role ?? 'PARTICIPANT',
      status: 'PENDING',
    };

    // Tenant-User membership item (for querying users in a tenant)
    const tenantUserItem: TenantUserItem = {
      PK: buildTenantPK(input.tenantId),
      SK: buildUserSK(id),
      GSI1PK: buildUserPK(id),
      GSI1SK: buildTenantPK(input.tenantId),
      EntityType: EntityType.USER,
      CreatedAt: now,
      UpdatedAt: now,
      tenantId: input.tenantId,
      userId: id,
      email: input.email,
      name: input.name,
      role: input.role ?? 'PARTICIPANT',
      status: 'PENDING',
    };

    // Use transaction to create both items atomically
    await client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: tableName,
              Item: userItem,
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
          {
            Put: {
              TableName: tableName,
              Item: tenantUserItem,
              ConditionExpression:
                'attribute_not_exists(PK) AND attribute_not_exists(SK)',
            },
          },
        ],
      })
    );

    return toDomain(userItem);
  }

  async findById(id: string): Promise<User | null> {
    const client = getDocClient();
    const tableName = getTableName();

    const result = await client.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          PK: buildUserPK(id),
          SK: buildMetadataSK(),
        },
      })
    );

    if (!result.Item) {
      return null;
    }

    return toDomain(result.Item as UserItem);
  }

  async findByEmail(email: string): Promise<User | null> {
    const client = getDocClient();
    const tableName = getTableName();

    const result = await client.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk AND GSI1SK = :sk',
        ExpressionAttributeValues: {
          ':pk': `EMAIL#${email}`,
          ':sk': buildMetadataSK(),
        },
        Limit: 1,
      })
    );

    if (!result.Items || result.Items.length === 0) {
      return null;
    }

    return toDomain(result.Items[0] as UserItem);
  }

  async findByTenantAndEmail(
    tenantId: string,
    email: string
  ): Promise<User | null> {
    // First find by email, then verify tenant
    const user = await this.findByEmail(email);
    if (!user || user.tenantId !== tenantId) {
      return null;
    }
    return user;
  }

  async listByTenant(
    tenantId: string,
    options?: {
      status?: UserStatus;
      role?: UserRole;
      limit?: number;
      lastKey?: Record<string, unknown>;
    }
  ): Promise<{ users: User[]; lastKey?: Record<string, unknown> }> {
    const client = getDocClient();
    const tableName = getTableName();

    const filterExpressions: string[] = [];
    const expressionValues: Record<string, unknown> = {
      ':pk': buildTenantPK(tenantId),
      ':skPrefix': 'USER#',
    };
    const expressionNames: Record<string, string> = {};

    if (options?.status) {
      filterExpressions.push('#status = :status');
      expressionNames['#status'] = 'status';
      expressionValues[':status'] = options.status;
    }

    if (options?.role) {
      filterExpressions.push('#role = :role');
      expressionNames['#role'] = 'role';
      expressionValues[':role'] = options.role;
    }

    const result = await client.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
        FilterExpression:
          filterExpressions.length > 0
            ? filterExpressions.join(' AND ')
            : undefined,
        ExpressionAttributeValues: expressionValues,
        ExpressionAttributeNames:
          Object.keys(expressionNames).length > 0 ? expressionNames : undefined,
        Limit: options?.limit ?? 50,
        ExclusiveStartKey: options?.lastKey,
        ScanIndexForward: false, // Newest first (by SK which starts with USER#ULID)
      })
    );

    // Fetch full user details for each membership record
    const users = await Promise.all(
      (result.Items ?? []).map(async (item) => {
        const membershipItem = item as TenantUserItem;
        const user = await this.findById(membershipItem.userId);
        return user;
      })
    );

    return {
      users: users.filter((u): u is User => u !== null),
      lastKey: result.LastEvaluatedKey,
    };
  }

  async update(id: string, input: UpdateUserInput): Promise<User> {
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

    if (input.role !== undefined) {
      updateExpressions.push('#role = :role');
      expressionNames['#role'] = 'role';
      expressionValues[':role'] = input.role;
    }

    if (input.status !== undefined) {
      updateExpressions.push('#status = :status');
      expressionNames['#status'] = 'status';
      expressionValues[':status'] = input.status;
    }

    if (input.auth0Id !== undefined) {
      updateExpressions.push('#auth0Id = :auth0Id');
      expressionNames['#auth0Id'] = 'auth0Id';
      expressionValues[':auth0Id'] = input.auth0Id;
    }

    const result = await client.send(
      new UpdateCommand({
        TableName: tableName,
        Key: {
          PK: buildUserPK(id),
          SK: buildMetadataSK(),
        },
        UpdateExpression: `SET ${updateExpressions.join(', ')}`,
        ExpressionAttributeNames: expressionNames,
        ExpressionAttributeValues: expressionValues,
        ReturnValues: 'ALL_NEW',
        ConditionExpression: 'attribute_exists(PK)',
      })
    );

    // Also update the tenant-user membership item if role or status changed
    if (input.role !== undefined || input.status !== undefined) {
      const user = result.Attributes as UserItem;
      await this.updateTenantUserItem(user.tenantId, id, {
        role: input.role,
        status: input.status,
        name: input.name,
      });
    }

    return toDomain(result.Attributes as UserItem);
  }

  private async updateTenantUserItem(
    tenantId: string,
    userId: string,
    input: { role?: UserRole; status?: UserStatus; name?: string }
  ): Promise<void> {
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

    if (input.role !== undefined) {
      updateExpressions.push('#role = :role');
      expressionNames['#role'] = 'role';
      expressionValues[':role'] = input.role;
    }

    if (input.status !== undefined) {
      updateExpressions.push('#status = :status');
      expressionNames['#status'] = 'status';
      expressionValues[':status'] = input.status;
    }

    if (input.name !== undefined) {
      updateExpressions.push('#name = :name');
      expressionNames['#name'] = 'name';
      expressionValues[':name'] = input.name;
    }

    await client.send(
      new UpdateCommand({
        TableName: tableName,
        Key: {
          PK: buildTenantPK(tenantId),
          SK: buildUserSK(userId),
        },
        UpdateExpression: `SET ${updateExpressions.join(', ')}`,
        ExpressionAttributeNames: expressionNames,
        ExpressionAttributeValues: expressionValues,
      })
    );
  }

  async delete(id: string, tenantId: string): Promise<void> {
    const client = getDocClient();
    const tableName = getTableName();

    // Delete both the user item and the tenant-user membership item
    await client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Delete: {
              TableName: tableName,
              Key: {
                PK: buildUserPK(id),
                SK: buildMetadataSK(),
              },
            },
          },
          {
            Delete: {
              TableName: tableName,
              Key: {
                PK: buildTenantPK(tenantId),
                SK: buildUserSK(id),
              },
            },
          },
        ],
      })
    );
  }

  async countByTenant(tenantId: string): Promise<number> {
    const client = getDocClient();
    const tableName = getTableName();

    const result = await client.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
        ExpressionAttributeValues: {
          ':pk': buildTenantPK(tenantId),
          ':skPrefix': 'USER#',
        },
        Select: 'COUNT',
      })
    );

    return result.Count ?? 0;
  }
}
