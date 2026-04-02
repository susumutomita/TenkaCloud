import {
  PutCommand,
  GetCommand,
  UpdateCommand,
  QueryCommand,
  BatchWriteCommand,
  DeleteCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { ulid } from 'ulid';
import { getDocClient, getTableName } from '@tenkacloud/dynamodb';
import type {
  GameState,
  AttackLog,
  Attack,
  AttackPurchase,
  TeamVulnerability,
  Alliance,
  AllianceStatus,
  HealthCheckResult,
  Vote,
  ScoreWeight,
} from '../types';

// Key builders
const buildGamedayPK = (eventId: string) => `GAMEDAY#${eventId}`;
const buildMetadataSK = () => 'METADATA';
const buildAttackLogSK = (id: string) => `ATTACKLOG#${id}`;
const buildTeamSK = (teamId: string) => `TEAM#${teamId}`;
const buildAttackSK = (slug: string) => `ATTACK#${slug}`;
const buildPurchaseSK = (teamId: string, attackSlug: string) =>
  `PURCHASE#${teamId}#${attackSlug}`;
const buildVulnerabilitySK = (teamId: string, vulnSlug: string) =>
  `VULNERABILITY#${teamId}#${vulnSlug}`;
const buildAllianceSK = (allianceId: string) => `ALLIANCE#${allianceId}`;
const buildHealthCheckSK = (teamId: string, timestamp: string) =>
  `HEALTHCHECK#${teamId}#${timestamp}`;
const buildVoteSK = (voterId: string) => `VOTE#${voterId}`;
const buildMemberSK = (userId: string) => `MEMBER#${userId}`;
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
  websiteUrl: string | null;
  apiUrl: string | null;
  inviteCode: string;
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
  websiteUrl: string | null;
  apiUrl: string | null;
  inviteCode: string;
}

function toTeamState(item: TeamStateItem): TeamState {
  return {
    eventId: item.eventId,
    teamId: item.teamId,
    teamName: item.teamName,
    score: item.score,
    isHealthy: item.isHealthy,
    websiteUrl: item.websiteUrl ?? null,
    apiUrl: item.apiUrl ?? null,
    inviteCode: item.inviteCode ?? '',
  };
}

interface MemberItem {
  PK: string;
  SK: string;
  EntityType: string;
  eventId: string;
  userId: string;
  teamId: string;
  teamName: string;
  mode: 'solo' | 'team';
  CreatedAt: string;
}

export interface MemberRecord {
  eventId: string;
  userId: string;
  teamId: string;
  teamName: string;
  mode: 'solo' | 'team';
}

function toMemberRecord(item: MemberItem): MemberRecord {
  return {
    eventId: item.eventId,
    userId: item.userId,
    teamId: item.teamId,
    teamName: item.teamName,
    mode: item.mode,
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

export class AttackAlreadyPurchasedError extends Error {
  constructor() {
    super('この攻撃は既に購入済みです');
    this.name = 'AttackAlreadyPurchasedError';
  }
}

export class VoteAlreadyExistsError extends Error {
  constructor() {
    super('既に投票済みです');
    this.name = 'VoteAlreadyExistsError';
  }
}

export class TeamAlreadyExistsError extends Error {
  constructor(teamId: string) {
    super(`チームは既に登録済みです: ${teamId}`);
    this.name = 'TeamAlreadyExistsError';
  }
}

export class GamedayRepository {
  // === ゲーム状態 ===

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

  async enableBlackout(eventId: string): Promise<GameState | null> {
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
          UpdateExpression: 'SET blackout = :true, UpdatedAt = :now',
          ExpressionAttributeValues: {
            ':true': true,
            ':now': now,
            ':false': false,
          },
          // 冪等: blackout が false の場合のみ更新
          ConditionExpression: 'attribute_exists(PK) AND blackout = :false',
          ReturnValues: 'ALL_NEW',
        })
      );

      if (!result.Attributes) return null;
      return toGameState(result.Attributes as GameStateItem);
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        // 既に blackout=true → 何もせず現状を返す
        return this.getGameState(eventId);
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

  // === チーム登録 ===

  async createTeam(input: {
    eventId: string;
    teamId: string;
    teamName: string;
    websiteUrl?: string;
    apiUrl?: string;
    inviteCode?: string;
  }): Promise<TeamState> {
    const client = getDocClient();
    const tableName = getTableName();
    const now = new Date().toISOString();
    const inviteCode =
      input.inviteCode ??
      Math.random().toString(36).substring(2, 8).toUpperCase();

    const item: TeamStateItem = {
      PK: buildGamedayPK(input.eventId),
      SK: buildTeamSK(input.teamId),
      EntityType: 'TEAM',
      eventId: input.eventId,
      teamId: input.teamId,
      teamName: input.teamName,
      score: 0,
      isHealthy: true,
      websiteUrl: input.websiteUrl ?? null,
      apiUrl: input.apiUrl ?? null,
      inviteCode,
      CreatedAt: now,
      UpdatedAt: now,
    };

    try {
      await client.send(
        new PutCommand({
          TableName: tableName,
          Item: item,
          ConditionExpression:
            'attribute_not_exists(PK) AND attribute_not_exists(SK)',
        })
      );
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        throw new TeamAlreadyExistsError(input.teamId);
      }
      throw error;
    }

    return toTeamState(item);
  }

  async updateTeamUrls(
    eventId: string,
    teamId: string,
    urls: { websiteUrl?: string; apiUrl?: string }
  ): Promise<void> {
    const client = getDocClient();
    const tableName = getTableName();
    const now = new Date().toISOString();

    const expressionParts: string[] = ['UpdatedAt = :now'];
    const expressionValues: Record<string, unknown> = { ':now': now };

    if (urls.websiteUrl !== undefined) {
      expressionParts.push('websiteUrl = :wUrl');
      expressionValues[':wUrl'] = urls.websiteUrl;
    }
    if (urls.apiUrl !== undefined) {
      expressionParts.push('apiUrl = :aUrl');
      expressionValues[':aUrl'] = urls.apiUrl;
    }

    try {
      await client.send(
        new UpdateCommand({
          TableName: tableName,
          Key: {
            PK: buildGamedayPK(eventId),
            SK: buildTeamSK(teamId),
          },
          UpdateExpression: `SET ${expressionParts.join(', ')}`,
          ExpressionAttributeValues: expressionValues,
          ConditionExpression: 'attribute_exists(PK) AND attribute_exists(SK)',
        })
      );
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        return;
      }
      throw error;
    }
  }

  async updateTeamHealthy(
    eventId: string,
    teamId: string,
    isHealthy: boolean
  ): Promise<void> {
    const client = getDocClient();
    const tableName = getTableName();
    const now = new Date().toISOString();

    await client.send(
      new UpdateCommand({
        TableName: tableName,
        Key: {
          PK: buildGamedayPK(eventId),
          SK: buildTeamSK(teamId),
        },
        UpdateExpression: 'SET isHealthy = :h, UpdatedAt = :now',
        ExpressionAttributeValues: {
          ':h': isHealthy,
          ':now': now,
        },
      })
    );
  }

  // === 攻撃ログ ===

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

  // === チーム ===

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

  async findTeamByInviteCode(
    eventId: string,
    inviteCode: string
  ): Promise<TeamState | null> {
    const teams = await this.listTeams(eventId);
    return teams.find((t) => t.inviteCode === inviteCode) ?? null;
  }

  async updateTeamScore(
    eventId: string,
    teamId: string,
    delta: number
  ): Promise<void> {
    const client = getDocClient();
    const tableName = getTableName();
    const now = new Date().toISOString();

    await client.send(
      new UpdateCommand({
        TableName: tableName,
        Key: {
          PK: buildGamedayPK(eventId),
          SK: buildTeamSK(teamId),
        },
        UpdateExpression: 'ADD score :delta SET UpdatedAt = :now',
        ExpressionAttributeValues: {
          ':delta': delta,
          ':now': now,
        },
      })
    );
  }

  async updateMultipleTeamScores(
    eventId: string,
    updates: Array<{ teamId: string; delta: number }>
  ): Promise<void> {
    if (updates.length === 0) return;

    const client = getDocClient();
    const tableName = getTableName();
    const now = new Date().toISOString();

    await client.send(
      new TransactWriteCommand({
        TransactItems: updates.map(({ teamId, delta }) => ({
          Update: {
            TableName: tableName,
            Key: {
              PK: buildGamedayPK(eventId),
              SK: buildTeamSK(teamId),
            },
            UpdateExpression: 'ADD score :delta SET UpdatedAt = :now',
            ExpressionAttributeValues: {
              ':delta': delta,
              ':now': now,
            },
          },
        })),
      })
    );
  }

  // === 攻撃カタログ ===

  async listAttackCatalog(eventId: string): Promise<Attack[]> {
    const client = getDocClient();
    const tableName = getTableName();
    const allItems: Attack[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;

    do {
      const result = await client.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
          ExpressionAttributeValues: {
            ':pk': buildGamedayPK(eventId),
            ':skPrefix': 'ATTACK#',
          },
          ExclusiveStartKey: exclusiveStartKey,
        })
      );

      for (const item of result.Items ?? []) {
        allItems.push(item as unknown as Attack);
      }
      exclusiveStartKey = result.LastEvaluatedKey as
        | Record<string, unknown>
        | undefined;
    } while (exclusiveStartKey);

    return allItems;
  }

  async getAttack(eventId: string, slug: string): Promise<Attack | null> {
    const client = getDocClient();
    const tableName = getTableName();

    const result = await client.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          PK: buildGamedayPK(eventId),
          SK: buildAttackSK(slug),
        },
      })
    );

    if (!result.Item) {
      return null;
    }

    return result.Item as unknown as Attack;
  }

  async seedAttackCatalog(eventId: string, attacks: Attack[]): Promise<void> {
    const client = getDocClient();
    const tableName = getTableName();

    // BatchWrite は最大25件ずつ
    const chunks: Attack[][] = [];
    for (let i = 0; i < attacks.length; i += 25) {
      chunks.push(attacks.slice(i, i + 25));
    }

    for (const chunk of chunks) {
      await client.send(
        new BatchWriteCommand({
          RequestItems: {
            [tableName]: chunk.map((attack) => ({
              PutRequest: {
                Item: {
                  PK: buildGamedayPK(eventId),
                  SK: buildAttackSK(attack.slug),
                  EntityType: 'ATTACK',
                  ...attack,
                },
              },
            })),
          },
        })
      );
    }
  }

  // === 攻撃購入 ===

  async getAttackPurchase(
    eventId: string,
    teamId: string,
    attackSlug: string
  ): Promise<AttackPurchase | null> {
    const client = getDocClient();
    const tableName = getTableName();

    const result = await client.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          PK: buildGamedayPK(eventId),
          SK: buildPurchaseSK(teamId, attackSlug),
        },
      })
    );

    if (!result.Item) {
      return null;
    }

    return result.Item as unknown as AttackPurchase;
  }

  async createAttackPurchase(input: {
    eventId: string;
    teamId: string;
    attackId: string;
    attackSlug: string;
  }): Promise<AttackPurchase> {
    const client = getDocClient();
    const tableName = getTableName();
    const id = ulid();
    const now = new Date().toISOString();

    const item = {
      PK: buildGamedayPK(input.eventId),
      SK: buildPurchaseSK(input.teamId, input.attackSlug),
      EntityType: 'PURCHASE',
      id,
      eventId: input.eventId,
      teamId: input.teamId,
      attackId: input.attackId,
      attackSlug: input.attackSlug,
      purchasedAt: now,
      lastUsedAt: null,
    };

    try {
      await client.send(
        new PutCommand({
          TableName: tableName,
          Item: item,
          ConditionExpression:
            'attribute_not_exists(PK) AND attribute_not_exists(SK)',
        })
      );
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        throw new AttackAlreadyPurchasedError();
      }
      throw error;
    }

    return item as unknown as AttackPurchase;
  }

  async updatePurchaseLastUsedAt(
    eventId: string,
    teamId: string,
    attackSlug: string,
    timestamp: string
  ): Promise<void> {
    const client = getDocClient();
    const tableName = getTableName();

    await client.send(
      new UpdateCommand({
        TableName: tableName,
        Key: {
          PK: buildGamedayPK(eventId),
          SK: buildPurchaseSK(teamId, attackSlug),
        },
        UpdateExpression: 'SET lastUsedAt = :ts',
        ExpressionAttributeValues: {
          ':ts': timestamp,
        },
      })
    );
  }

  // === 脆弱性 ===

  async getTeamVulnerability(
    eventId: string,
    teamId: string,
    vulnSlug: string
  ): Promise<TeamVulnerability | null> {
    const client = getDocClient();
    const tableName = getTableName();

    const result = await client.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          PK: buildGamedayPK(eventId),
          SK: buildVulnerabilitySK(teamId, vulnSlug),
        },
      })
    );

    if (!result.Item) {
      return null;
    }

    return result.Item as unknown as TeamVulnerability;
  }

  async upsertTeamVulnerability(input: {
    eventId: string;
    teamId: string;
    vulnerabilitySlug: string;
    isFixed: boolean;
  }): Promise<TeamVulnerability> {
    const client = getDocClient();
    const tableName = getTableName();
    const id = ulid();

    const item = {
      PK: buildGamedayPK(input.eventId),
      SK: buildVulnerabilitySK(input.teamId, input.vulnerabilitySlug),
      EntityType: 'VULNERABILITY',
      id,
      eventId: input.eventId,
      teamId: input.teamId,
      vulnerabilitySlug: input.vulnerabilitySlug,
      isFixed: input.isFixed,
    };

    await client.send(
      new PutCommand({
        TableName: tableName,
        Item: item,
      })
    );

    return item as unknown as TeamVulnerability;
  }

  // === 同盟 ===

  async listAlliances(eventId: string): Promise<Alliance[]> {
    const client = getDocClient();
    const tableName = getTableName();
    const allItems: Alliance[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;

    do {
      const result = await client.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
          ExpressionAttributeValues: {
            ':pk': buildGamedayPK(eventId),
            ':skPrefix': 'ALLIANCE#',
          },
          ExclusiveStartKey: exclusiveStartKey,
        })
      );

      for (const item of result.Items ?? []) {
        allItems.push(item as unknown as Alliance);
      }
      exclusiveStartKey = result.LastEvaluatedKey as
        | Record<string, unknown>
        | undefined;
    } while (exclusiveStartKey);

    return allItems;
  }

  async listTeamActiveAlliances(
    eventId: string,
    teamId: string
  ): Promise<Alliance[]> {
    const client = getDocClient();
    const tableName = getTableName();
    const allItems: Alliance[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;

    do {
      const result = await client.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
          FilterExpression:
            '#status = :active AND (#requester = :teamId OR #target = :teamId)',
          ExpressionAttributeNames: {
            '#status': 'status',
            '#requester': 'requesterTeamId',
            '#target': 'targetTeamId',
          },
          ExpressionAttributeValues: {
            ':pk': buildGamedayPK(eventId),
            ':skPrefix': 'ALLIANCE#',
            ':active': 'ACTIVE',
            ':teamId': teamId,
          },
          ExclusiveStartKey: exclusiveStartKey,
        })
      );

      for (const item of result.Items ?? []) {
        allItems.push(item as unknown as Alliance);
      }
      exclusiveStartKey = result.LastEvaluatedKey as
        | Record<string, unknown>
        | undefined;
    } while (exclusiveStartKey);

    return allItems;
  }

  async getAlliance(
    eventId: string,
    allianceId: string
  ): Promise<Alliance | null> {
    const client = getDocClient();
    const tableName = getTableName();

    const result = await client.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          PK: buildGamedayPK(eventId),
          SK: buildAllianceSK(allianceId),
        },
      })
    );

    if (!result.Item) {
      return null;
    }

    return result.Item as unknown as Alliance;
  }

  async createAlliance(input: {
    eventId: string;
    requesterTeamId: string;
    targetTeamId: string;
  }): Promise<Alliance> {
    const client = getDocClient();
    const tableName = getTableName();
    const id = ulid();
    const now = new Date().toISOString();

    const item = {
      PK: buildGamedayPK(input.eventId),
      SK: buildAllianceSK(id),
      EntityType: 'ALLIANCE',
      id,
      eventId: input.eventId,
      requesterTeamId: input.requesterTeamId,
      targetTeamId: input.targetTeamId,
      status: 'PENDING' as AllianceStatus,
      createdAt: now,
      updatedAt: now,
    };

    await client.send(
      new PutCommand({
        TableName: tableName,
        Item: item,
      })
    );

    return item as unknown as Alliance;
  }

  async updateAllianceStatus(
    eventId: string,
    allianceId: string,
    status: AllianceStatus
  ): Promise<void> {
    const client = getDocClient();
    const tableName = getTableName();
    const now = new Date().toISOString();

    await client.send(
      new UpdateCommand({
        TableName: tableName,
        Key: {
          PK: buildGamedayPK(eventId),
          SK: buildAllianceSK(allianceId),
        },
        UpdateExpression: 'SET #status = :status, updatedAt = :now',
        ExpressionAttributeNames: {
          '#status': 'status',
        },
        ExpressionAttributeValues: {
          ':status': status,
          ':now': now,
        },
      })
    );
  }

  async deleteAlliance(eventId: string, allianceId: string): Promise<void> {
    const client = getDocClient();
    const tableName = getTableName();

    await client.send(
      new DeleteCommand({
        TableName: tableName,
        Key: {
          PK: buildGamedayPK(eventId),
          SK: buildAllianceSK(allianceId),
        },
      })
    );
  }

  // === ヘルスチェック ===

  async listHealthChecks(
    eventId: string,
    teamId: string
  ): Promise<HealthCheckResult[]> {
    const client = getDocClient();
    const tableName = getTableName();
    const allItems: HealthCheckResult[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;

    do {
      const result = await client.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
          ExpressionAttributeValues: {
            ':pk': buildGamedayPK(eventId),
            ':skPrefix': `HEALTHCHECK#${teamId}#`,
          },
          ScanIndexForward: false,
          ExclusiveStartKey: exclusiveStartKey,
        })
      );

      for (const item of result.Items ?? []) {
        // Kumo の begins_with バグ回避: アプリ側でフィルタ
        const sk = (item as Record<string, unknown>).SK as string | undefined;
        if (sk && sk.startsWith(`HEALTHCHECK#${teamId}#`)) {
          allItems.push(item as unknown as HealthCheckResult);
        }
      }
      exclusiveStartKey = result.LastEvaluatedKey as
        | Record<string, unknown>
        | undefined;
    } while (exclusiveStartKey);

    return allItems;
  }

  async createHealthCheck(input: {
    eventId: string;
    teamId: string;
    checkType: 'website' | 'api';
    isHealthy: boolean;
    statusCode: number | null;
    responseTimeMs: number | null;
  }): Promise<HealthCheckResult> {
    const client = getDocClient();
    const tableName = getTableName();
    const id = ulid();
    const now = new Date().toISOString();

    const item = {
      PK: buildGamedayPK(input.eventId),
      SK: buildHealthCheckSK(input.teamId, now),
      EntityType: 'HEALTHCHECK',
      id,
      eventId: input.eventId,
      teamId: input.teamId,
      checkType: input.checkType,
      isHealthy: input.isHealthy,
      statusCode: input.statusCode,
      responseTimeMs: input.responseTimeMs,
      createdAt: now,
    };

    await client.send(
      new PutCommand({
        TableName: tableName,
        Item: item,
      })
    );

    return item as unknown as HealthCheckResult;
  }

  // === 投票 ===

  async castVote(input: {
    eventId: string;
    voterTeamId: string;
    votedForTeamId: string;
  }): Promise<Vote> {
    const client = getDocClient();
    const tableName = getTableName();
    const id = ulid();
    const now = new Date().toISOString();

    const item = {
      PK: buildGamedayPK(input.eventId),
      SK: buildVoteSK(input.voterTeamId),
      EntityType: 'VOTE',
      id,
      eventId: input.eventId,
      voterTeamId: input.voterTeamId,
      votedForTeamId: input.votedForTeamId,
      createdAt: now,
    };

    try {
      await client.send(
        new PutCommand({
          TableName: tableName,
          Item: item,
          ConditionExpression:
            'attribute_not_exists(PK) AND attribute_not_exists(SK)',
        })
      );
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        throw new VoteAlreadyExistsError();
      }
      throw error;
    }

    return item as unknown as Vote;
  }

  async listVotes(eventId: string): Promise<Vote[]> {
    const client = getDocClient();
    const tableName = getTableName();
    const allItems: Vote[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;

    do {
      const result = await client.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
          ExpressionAttributeValues: {
            ':pk': buildGamedayPK(eventId),
            ':skPrefix': 'VOTE#',
          },
          ExclusiveStartKey: exclusiveStartKey,
        })
      );

      for (const item of result.Items ?? []) {
        allItems.push(item as unknown as Vote);
      }
      exclusiveStartKey = result.LastEvaluatedKey as
        | Record<string, unknown>
        | undefined;
    } while (exclusiveStartKey);

    return allItems;
  }

  // === メンバーシップ ===

  async addMember(input: {
    eventId: string;
    userId: string;
    teamId: string;
    teamName: string;
    mode: 'solo' | 'team';
  }): Promise<MemberRecord> {
    const client = getDocClient();
    const tableName = getTableName();
    const now = new Date().toISOString();

    const item: MemberItem = {
      PK: buildGamedayPK(input.eventId),
      SK: buildMemberSK(input.userId),
      EntityType: 'MEMBER',
      eventId: input.eventId,
      userId: input.userId,
      teamId: input.teamId,
      teamName: input.teamName,
      mode: input.mode,
      CreatedAt: now,
    };

    await client.send(
      new PutCommand({
        TableName: tableName,
        Item: item,
      })
    );

    return toMemberRecord(item);
  }

  async getMembership(
    eventId: string,
    userId: string
  ): Promise<MemberRecord | null> {
    const client = getDocClient();
    const tableName = getTableName();

    const result = await client.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          PK: buildGamedayPK(eventId),
          SK: buildMemberSK(userId),
        },
      })
    );

    if (!result.Item) {
      return null;
    }

    return toMemberRecord(result.Item as MemberItem);
  }
}
