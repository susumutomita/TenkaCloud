import {
  PutCommand,
  GetCommand,
  UpdateCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { ulid } from 'ulid';
import { getDocClient, getTableName } from '@tenkacloud/dynamodb';
import type { GameState, AttackLog, ScoreWeight } from '../types';

// Key builders
const buildGamedayPK = (eventId: string) => `GAMEDAY#${eventId}`;
const buildMetadataSK = () => 'METADATA';
const buildAttackLogSK = (id: string) => `ATTACKLOG#${id}`;
const buildTeamSK = (teamId: string) => `TEAM#${teamId}`;
const buildTenantGamedayGSI = (tenantId: string) =>
  `TENANT#${tenantId}#GAMEDAY`;

interface GameStateItem {
  PK: string;
  SK: string;
  GSI1PK: string;
  GSI1SK: string;
  EntityType: string;
  eventId: string;
  tenantId: string;
  isRunning: boolean;
  startedAt: string | null;
  scoreWeight: ScoreWeight;
  blackout: boolean;
  durationMinutes: number;
  CreatedAt: string;
  UpdatedAt: string;
}

interface AttackLogItem {
  PK: string;
  SK: string;
  EntityType: string;
  id: string;
  eventId: string;
  attackerTeamId: string;
  defenderTeamId: string;
  attackId: string;
  attackSlug: string;
  success: boolean;
  neutralized: boolean;
  damage: number;
  reward: number;
  details: string;
  createdAt: string;
}

interface TeamStateItem {
  PK: string;
  SK: string;
  EntityType: string;
  eventId: string;
  teamId: string;
  teamName: string;
  score: number;
  isHealthy: boolean;
  CreatedAt: string;
  UpdatedAt: string;
}

function toGameState(item: GameStateItem): GameState {
  return {
    eventId: item.eventId,
    tenantId: item.tenantId,
    isRunning: item.isRunning,
    startedAt: item.startedAt,
    scoreWeight: item.scoreWeight,
    blackout: item.blackout,
    durationMinutes: item.durationMinutes,
  };
}

function toAttackLog(item: AttackLogItem): AttackLog {
  return {
    id: item.id,
    eventId: item.eventId,
    attackerTeamId: item.attackerTeamId,
    defenderTeamId: item.defenderTeamId,
    attackId: item.attackId,
    attackSlug: item.attackSlug,
    success: item.success,
    neutralized: item.neutralized,
    damage: item.damage,
    reward: item.reward,
    details: item.details,
    createdAt: item.createdAt,
  };
}

export interface TeamState {
  eventId: string;
  teamId: string;
  teamName: string;
  score: number;
  isHealthy: boolean;
}

function toTeamState(item: TeamStateItem): TeamState {
  return {
    eventId: item.eventId,
    teamId: item.teamId,
    teamName: item.teamName,
    score: item.score,
    isHealthy: item.isHealthy,
  };
}

export class GameAlreadyExistsError extends Error {
  constructor(eventId: string) {
    super(`ゲームは既に存在します: ${eventId}`);
    this.name = 'GameAlreadyExistsError';
  }
}

export class ConcurrentModificationError extends Error {
  constructor() {
    super('同時変更が検出されました。もう一度お試しください');
    this.name = 'ConcurrentModificationError';
  }
}

export class GamedayRepository {
  async createGameState(input: {
    eventId: string;
    tenantId: string;
    durationMinutes: number;
  }): Promise<GameState> {
    const client = getDocClient();
    const tableName = getTableName();
    const now = new Date().toISOString();

    const item: GameStateItem = {
      PK: buildGamedayPK(input.eventId),
      SK: buildMetadataSK(),
      GSI1PK: buildTenantGamedayGSI(input.tenantId),
      GSI1SK: now,
      EntityType: 'GAMEDAY',
      eventId: input.eventId,
      tenantId: input.tenantId,
      isRunning: true,
      startedAt: now,
      scoreWeight: 'normal',
      blackout: false,
      durationMinutes: input.durationMinutes,
      CreatedAt: now,
      UpdatedAt: now,
    };

    try {
      await client.send(
        new PutCommand({
          TableName: tableName,
          Item: item,
          ConditionExpression: 'attribute_not_exists(PK)',
        })
      );
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        throw new GameAlreadyExistsError(input.eventId);
      }
      throw error;
    }

    return toGameState(item);
  }

  async getGameState(eventId: string): Promise<GameState | null> {
    const client = getDocClient();
    const tableName = getTableName();

    const result = await client.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          PK: buildGamedayPK(eventId),
          SK: buildMetadataSK(),
        },
      })
    );

    if (!result.Item) {
      return null;
    }

    return toGameState(result.Item as GameStateItem);
  }

  async stopGame(eventId: string): Promise<GameState | null> {
    const client = getDocClient();
    const tableName = getTableName();
    const now = new Date().toISOString();

    try {
      const result = await client.send(
        new UpdateCommand({
          TableName: tableName,
          Key: {
            PK: buildGamedayPK(eventId),
            SK: buildMetadataSK(),
          },
          UpdateExpression: 'SET isRunning = :running, UpdatedAt = :now',
          ExpressionAttributeValues: {
            ':running': false,
            ':now': now,
          },
          ConditionExpression: 'attribute_exists(PK)',
          ReturnValues: 'ALL_NEW',
        })
      );

      if (!result.Attributes) {
        return null;
      }

      return toGameState(result.Attributes as GameStateItem);
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        return null;
      }
      throw error;
    }
  }

  async toggleScoreWeight(eventId: string): Promise<GameState | null> {
    const current = await this.getGameState(eventId);
    if (!current) {
      return null;
    }

    const newWeight: ScoreWeight =
      current.scoreWeight === 'normal' ? 'high' : 'normal';
    const client = getDocClient();
    const tableName = getTableName();
    const now = new Date().toISOString();

    try {
      const result = await client.send(
        new UpdateCommand({
          TableName: tableName,
          Key: {
            PK: buildGamedayPK(eventId),
            SK: buildMetadataSK(),
          },
          UpdateExpression: 'SET scoreWeight = :weight, UpdatedAt = :now',
          ExpressionAttributeValues: {
            ':weight': newWeight,
            ':now': now,
            ':expectedWeight': current.scoreWeight,
          },
          ConditionExpression:
            'attribute_exists(PK) AND scoreWeight = :expectedWeight',
          ReturnValues: 'ALL_NEW',
        })
      );

      if (!result.Attributes) {
        return null;
      }

      return toGameState(result.Attributes as GameStateItem);
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        throw new ConcurrentModificationError();
      }
      throw error;
    }
  }

  async toggleBlackout(eventId: string): Promise<GameState | null> {
    const current = await this.getGameState(eventId);
    if (!current) {
      return null;
    }

    const client = getDocClient();
    const tableName = getTableName();
    const now = new Date().toISOString();

    try {
      const result = await client.send(
        new UpdateCommand({
          TableName: tableName,
          Key: {
            PK: buildGamedayPK(eventId),
            SK: buildMetadataSK(),
          },
          UpdateExpression: 'SET blackout = :blackout, UpdatedAt = :now',
          ExpressionAttributeValues: {
            ':blackout': !current.blackout,
            ':now': now,
            ':expectedBlackout': current.blackout,
          },
          ConditionExpression:
            'attribute_exists(PK) AND blackout = :expectedBlackout',
          ReturnValues: 'ALL_NEW',
        })
      );

      if (!result.Attributes) {
        return null;
      }

      return toGameState(result.Attributes as GameStateItem);
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        throw new ConcurrentModificationError();
      }
      throw error;
    }
  }

  async addAttackLog(input: {
    eventId: string;
    attackerTeamId: string;
    defenderTeamId: string;
    attackId: string;
    attackSlug: string;
    success: boolean;
    damage: number;
    reward: number;
    details: string;
  }): Promise<AttackLog> {
    const client = getDocClient();
    const tableName = getTableName();
    const id = ulid();
    const now = new Date().toISOString();

    const item: AttackLogItem = {
      PK: buildGamedayPK(input.eventId),
      SK: buildAttackLogSK(id),
      EntityType: 'GAMEDAY_ATTACK_LOG',
      id,
      eventId: input.eventId,
      attackerTeamId: input.attackerTeamId,
      defenderTeamId: input.defenderTeamId,
      attackId: input.attackId,
      attackSlug: input.attackSlug,
      success: input.success,
      neutralized: false,
      damage: input.damage,
      reward: input.reward,
      details: input.details,
      createdAt: now,
    };

    await client.send(
      new PutCommand({
        TableName: tableName,
        Item: item,
      })
    );

    return toAttackLog(item);
  }

  async listAttackLogs(eventId: string): Promise<AttackLog[]> {
    const client = getDocClient();
    const tableName = getTableName();
    const allItems: AttackLog[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;

    do {
      const result = await client.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
          ExpressionAttributeValues: {
            ':pk': buildGamedayPK(eventId),
            ':skPrefix': 'ATTACKLOG#',
          },
          ScanIndexForward: false,
          ExclusiveStartKey: exclusiveStartKey,
        })
      );

      for (const item of result.Items ?? []) {
        allItems.push(toAttackLog(item as AttackLogItem));
      }
      exclusiveStartKey = result.LastEvaluatedKey as
        | Record<string, unknown>
        | undefined;
    } while (exclusiveStartKey);

    return allItems;
  }

  async getTeamState(
    eventId: string,
    teamId: string
  ): Promise<TeamState | null> {
    const client = getDocClient();
    const tableName = getTableName();

    const result = await client.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          PK: buildGamedayPK(eventId),
          SK: buildTeamSK(teamId),
        },
      })
    );

    if (!result.Item) {
      return null;
    }

    return toTeamState(result.Item as TeamStateItem);
  }

  async listTeams(eventId: string): Promise<TeamState[]> {
    const client = getDocClient();
    const tableName = getTableName();
    const allItems: TeamState[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;

    do {
      const result = await client.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
          ExpressionAttributeValues: {
            ':pk': buildGamedayPK(eventId),
            ':skPrefix': 'TEAM#',
          },
          ExclusiveStartKey: exclusiveStartKey,
        })
      );

      for (const item of result.Items ?? []) {
        allItems.push(toTeamState(item as TeamStateItem));
      }
      exclusiveStartKey = result.LastEvaluatedKey as
        | Record<string, unknown>
        | undefined;
    } while (exclusiveStartKey);

    return allItems;
  }
}
