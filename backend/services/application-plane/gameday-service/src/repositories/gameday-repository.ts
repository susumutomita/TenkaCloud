import {
  PutCommand,
  GetCommand,
  UpdateCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
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

    await client.send(
      new PutCommand({
        TableName: tableName,
        Item: item,
        ConditionExpression: 'attribute_not_exists(PK)',
      })
    );

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
        },
        ConditionExpression: 'attribute_exists(PK)',
        ReturnValues: 'ALL_NEW',
      })
    );

    if (!result.Attributes) {
      return null;
    }

    return toGameState(result.Attributes as GameStateItem);
  }

  async toggleBlackout(eventId: string): Promise<GameState | null> {
    const current = await this.getGameState(eventId);
    if (!current) {
      return null;
    }

    const client = getDocClient();
    const tableName = getTableName();
    const now = new Date().toISOString();

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
        },
        ConditionExpression: 'attribute_exists(PK)',
        ReturnValues: 'ALL_NEW',
      })
    );

    if (!result.Attributes) {
      return null;
    }

    return toGameState(result.Attributes as GameStateItem);
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

    const result = await client.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
        ExpressionAttributeValues: {
          ':pk': buildGamedayPK(eventId),
          ':skPrefix': 'ATTACKLOG#',
        },
        ScanIndexForward: false,
      })
    );

    return (result.Items ?? []).map((item) =>
      toAttackLog(item as AttackLogItem)
    );
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

    const result = await client.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
        ExpressionAttributeValues: {
          ':pk': buildGamedayPK(eventId),
          ':skPrefix': 'TEAM#',
        },
      })
    );

    return (result.Items ?? []).map((item) =>
      toTeamState(item as TeamStateItem)
    );
  }
}
