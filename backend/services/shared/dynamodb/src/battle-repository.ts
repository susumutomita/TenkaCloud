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
  Battle,
  BattleItem,
  BattleParticipant,
  BattleParticipantItem,
  BattleTeam,
  BattleTeamItem,
  BattleHistory,
  BattleHistoryItem,
  CreateBattleInput,
  UpdateBattleInput,
  BattleStatus,
} from './types';
import { EntityType } from './types';

// Key builders
const buildBattlePK = (id: string) => `BATTLE#${id}`;
const buildMetadataSK = () => 'METADATA';
const buildParticipantSK = (userId: string) => `PARTICIPANT#${userId}`;
const buildTeamSK = (teamId: string) => `TEAM#${teamId}`;
const buildHistorySK = (timestamp: string) => `HISTORY#${timestamp}`;
const buildTenantBattleGSI = (tenantId: string) => `TENANT#${tenantId}#BATTLE`;

// Convert DynamoDB item to domain object
function toBattle(item: BattleItem): Battle {
  return {
    id: item.id,
    tenantId: item.tenantId,
    title: item.title,
    description: item.description,
    mode: item.mode,
    status: item.status,
    maxParticipants: item.maxParticipants,
    timeLimit: item.timeLimit,
    startedAt: item.startedAt ? new Date(item.startedAt) : undefined,
    endedAt: item.endedAt ? new Date(item.endedAt) : undefined,
    createdAt: new Date(item.CreatedAt),
    updatedAt: new Date(item.UpdatedAt),
  };
}

function toParticipant(item: BattleParticipantItem): BattleParticipant {
  return {
    id: item.id,
    battleId: item.battleId,
    userId: item.userId,
    teamId: item.teamId,
    score: item.score,
    rank: item.rank,
    joinedAt: new Date(item.joinedAt),
    leftAt: item.leftAt ? new Date(item.leftAt) : undefined,
  };
}

function toTeam(item: BattleTeamItem): BattleTeam {
  return {
    id: item.id,
    battleId: item.battleId,
    name: item.name,
    score: item.score,
    createdAt: new Date(item.CreatedAt),
  };
}

function toHistory(item: BattleHistoryItem): BattleHistory {
  return {
    id: item.id,
    battleId: item.battleId,
    eventType: item.eventType,
    payload: item.payload,
    timestamp: new Date(item.timestamp),
  };
}

export class BattleRepository {
  async create(input: CreateBattleInput): Promise<Battle> {
    const client = getDocClient();
    const tableName = getTableName();
    const now = new Date().toISOString();
    const id = ulid();

    const item: BattleItem = {
      PK: buildBattlePK(id),
      SK: buildMetadataSK(),
      GSI1PK: buildTenantBattleGSI(input.tenantId),
      GSI1SK: now,
      EntityType: EntityType.BATTLE,
      CreatedAt: now,
      UpdatedAt: now,
      id,
      tenantId: input.tenantId,
      title: input.title,
      description: input.description,
      mode: input.mode,
      status: 'WAITING',
      maxParticipants: input.maxParticipants ?? 10,
      timeLimit: input.timeLimit ?? 3600,
    };

    await client.send(
      new PutCommand({
        TableName: tableName,
        Item: item,
        ConditionExpression: 'attribute_not_exists(PK)',
      })
    );

    return toBattle(item);
  }

  async findById(id: string): Promise<Battle | null> {
    const client = getDocClient();
    const tableName = getTableName();

    const result = await client.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          PK: buildBattlePK(id),
          SK: buildMetadataSK(),
        },
      })
    );

    if (!result.Item) {
      return null;
    }

    return toBattle(result.Item as BattleItem);
  }

  async findByIdAndTenant(
    id: string,
    tenantId: string
  ): Promise<Battle | null> {
    const battle = await this.findById(id);
    if (!battle || battle.tenantId !== tenantId) {
      return null;
    }
    return battle;
  }

  async listByTenant(
    tenantId: string,
    options?: {
      status?: BattleStatus;
      limit?: number;
      lastKey?: Record<string, unknown>;
    }
  ): Promise<{ battles: Battle[]; lastKey?: Record<string, unknown> }> {
    const client = getDocClient();
    const tableName = getTableName();

    let filterExpression: string | undefined;
    const expressionValues: Record<string, unknown> = {
      ':gsi1pk': buildTenantBattleGSI(tenantId),
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
        Limit: options?.limit ?? 20,
        ExclusiveStartKey: options?.lastKey,
        ScanIndexForward: false,
      })
    );

    const battles = (result.Items ?? []).map((item) =>
      toBattle(item as BattleItem)
    );

    return {
      battles,
      lastKey: result.LastEvaluatedKey,
    };
  }

  async countByTenant(
    tenantId: string,
    status?: BattleStatus
  ): Promise<number> {
    const client = getDocClient();
    const tableName = getTableName();

    let filterExpression: string | undefined;
    const expressionValues: Record<string, unknown> = {
      ':gsi1pk': buildTenantBattleGSI(tenantId),
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

  async update(id: string, input: UpdateBattleInput): Promise<Battle> {
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

    if (input.title !== undefined) {
      updateExpressions.push('#title = :title');
      expressionNames['#title'] = 'title';
      expressionValues[':title'] = input.title;
    }

    if (input.description !== undefined) {
      updateExpressions.push('#description = :description');
      expressionNames['#description'] = 'description';
      expressionValues[':description'] = input.description;
    }

    if (input.maxParticipants !== undefined) {
      updateExpressions.push('#maxParticipants = :maxParticipants');
      expressionNames['#maxParticipants'] = 'maxParticipants';
      expressionValues[':maxParticipants'] = input.maxParticipants;
    }

    if (input.timeLimit !== undefined) {
      updateExpressions.push('#timeLimit = :timeLimit');
      expressionNames['#timeLimit'] = 'timeLimit';
      expressionValues[':timeLimit'] = input.timeLimit;
    }

    if (input.status !== undefined) {
      updateExpressions.push('#status = :status');
      expressionNames['#status'] = 'status';
      expressionValues[':status'] = input.status;
    }

    if (input.startedAt !== undefined) {
      updateExpressions.push('#startedAt = :startedAt');
      expressionNames['#startedAt'] = 'startedAt';
      expressionValues[':startedAt'] = input.startedAt.toISOString();
    }

    if (input.endedAt !== undefined) {
      updateExpressions.push('#endedAt = :endedAt');
      expressionNames['#endedAt'] = 'endedAt';
      expressionValues[':endedAt'] = input.endedAt.toISOString();
    }

    const result = await client.send(
      new UpdateCommand({
        TableName: tableName,
        Key: {
          PK: buildBattlePK(id),
          SK: buildMetadataSK(),
        },
        UpdateExpression: `SET ${updateExpressions.join(', ')}`,
        ExpressionAttributeNames: expressionNames,
        ExpressionAttributeValues: expressionValues,
        ReturnValues: 'ALL_NEW',
        ConditionExpression: 'attribute_exists(PK)',
      })
    );

    return toBattle(result.Attributes as BattleItem);
  }

  async delete(id: string): Promise<void> {
    const client = getDocClient();
    const tableName = getTableName();

    // First, get all items with this battle PK to delete them all
    const queryResult = await client.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: {
          ':pk': buildBattlePK(id),
        },
      })
    );

    if (!queryResult.Items || queryResult.Items.length === 0) {
      return;
    }

    // Delete all items in a transaction (max 100 items)
    const items = queryResult.Items.slice(0, 100);
    await client.send(
      new TransactWriteCommand({
        TransactItems: items.map((item) => ({
          Delete: {
            TableName: tableName,
            Key: {
              PK: item.PK,
              SK: item.SK,
            },
          },
        })),
      })
    );
  }

  // Participant methods
  async addParticipant(
    battleId: string,
    userId: string,
    teamId?: string
  ): Promise<BattleParticipant> {
    const client = getDocClient();
    const tableName = getTableName();
    const now = new Date().toISOString();
    const id = ulid();

    const item: BattleParticipantItem = {
      PK: buildBattlePK(battleId),
      SK: buildParticipantSK(userId),
      GSI1PK: `USER#${userId}#BATTLE`,
      GSI1SK: now,
      EntityType: EntityType.BATTLE_PARTICIPANT,
      CreatedAt: now,
      UpdatedAt: now,
      id,
      battleId,
      userId,
      teamId,
      score: 0,
      joinedAt: now,
    };

    await client.send(
      new PutCommand({
        TableName: tableName,
        Item: item,
        ConditionExpression:
          'attribute_not_exists(PK) AND attribute_not_exists(SK)',
      })
    );

    return toParticipant(item);
  }

  async getParticipant(
    battleId: string,
    userId: string
  ): Promise<BattleParticipant | null> {
    const client = getDocClient();
    const tableName = getTableName();

    const result = await client.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          PK: buildBattlePK(battleId),
          SK: buildParticipantSK(userId),
        },
      })
    );

    if (!result.Item) {
      return null;
    }

    return toParticipant(result.Item as BattleParticipantItem);
  }

  async listParticipants(battleId: string): Promise<BattleParticipant[]> {
    const client = getDocClient();
    const tableName = getTableName();

    const result = await client.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
        ExpressionAttributeValues: {
          ':pk': buildBattlePK(battleId),
          ':skPrefix': 'PARTICIPANT#',
        },
      })
    );

    return (result.Items ?? []).map((item) =>
      toParticipant(item as BattleParticipantItem)
    );
  }

  async countActiveParticipants(battleId: string): Promise<number> {
    const client = getDocClient();
    const tableName = getTableName();

    const result = await client.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
        FilterExpression: 'attribute_not_exists(leftAt)',
        ExpressionAttributeValues: {
          ':pk': buildBattlePK(battleId),
          ':skPrefix': 'PARTICIPANT#',
        },
        Select: 'COUNT',
      })
    );

    return result.Count ?? 0;
  }

  async updateParticipant(
    battleId: string,
    userId: string,
    updates: { score?: number; leftAt?: Date }
  ): Promise<BattleParticipant> {
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

    if (updates.score !== undefined) {
      updateExpressions.push('#score = :score');
      expressionNames['#score'] = 'score';
      expressionValues[':score'] = updates.score;
    }

    if (updates.leftAt !== undefined) {
      updateExpressions.push('#leftAt = :leftAt');
      expressionNames['#leftAt'] = 'leftAt';
      expressionValues[':leftAt'] = updates.leftAt.toISOString();
    }

    const result = await client.send(
      new UpdateCommand({
        TableName: tableName,
        Key: {
          PK: buildBattlePK(battleId),
          SK: buildParticipantSK(userId),
        },
        UpdateExpression: `SET ${updateExpressions.join(', ')}`,
        ExpressionAttributeNames: expressionNames,
        ExpressionAttributeValues: expressionValues,
        ReturnValues: 'ALL_NEW',
        ConditionExpression: 'attribute_exists(PK)',
      })
    );

    return toParticipant(result.Attributes as BattleParticipantItem);
  }

  // Team methods
  async createTeam(battleId: string, name: string): Promise<BattleTeam> {
    const client = getDocClient();
    const tableName = getTableName();
    const now = new Date().toISOString();
    const id = ulid();

    const item: BattleTeamItem = {
      PK: buildBattlePK(battleId),
      SK: buildTeamSK(id),
      EntityType: EntityType.BATTLE_TEAM,
      CreatedAt: now,
      UpdatedAt: now,
      id,
      battleId,
      name,
      score: 0,
    };

    await client.send(
      new PutCommand({
        TableName: tableName,
        Item: item,
      })
    );

    return toTeam(item);
  }

  async listTeams(battleId: string): Promise<BattleTeam[]> {
    const client = getDocClient();
    const tableName = getTableName();

    const result = await client.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
        ExpressionAttributeValues: {
          ':pk': buildBattlePK(battleId),
          ':skPrefix': 'TEAM#',
        },
      })
    );

    return (result.Items ?? []).map((item) => toTeam(item as BattleTeamItem));
  }

  // History methods
  async addHistory(
    battleId: string,
    eventType: string,
    payload: Record<string, unknown>
  ): Promise<BattleHistory> {
    const client = getDocClient();
    const tableName = getTableName();
    const now = new Date().toISOString();
    const id = ulid();

    const item: BattleHistoryItem = {
      PK: buildBattlePK(battleId),
      SK: buildHistorySK(now),
      EntityType: EntityType.BATTLE_HISTORY,
      CreatedAt: now,
      UpdatedAt: now,
      id,
      battleId,
      eventType,
      payload,
      timestamp: now,
    };

    await client.send(
      new PutCommand({
        TableName: tableName,
        Item: item,
      })
    );

    return toHistory(item);
  }

  async listHistory(battleId: string): Promise<BattleHistory[]> {
    const client = getDocClient();
    const tableName = getTableName();

    const result = await client.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
        ExpressionAttributeValues: {
          ':pk': buildBattlePK(battleId),
          ':skPrefix': 'HISTORY#',
        },
        ScanIndexForward: false,
      })
    );

    return (result.Items ?? []).map((item) =>
      toHistory(item as BattleHistoryItem)
    );
  }
}
