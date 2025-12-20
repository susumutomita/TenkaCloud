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
  ScoringSession,
  ScoringSessionItem,
  EvaluationCriteria,
  EvaluationCriteriaItem,
  CreateScoringSessionInput,
  CreateEvaluationCriteriaInput,
  UpdateScoringSessionInput,
  UpdateEvaluationCriteriaInput,
  EvaluationStatus,
  EvaluationCategory,
} from './types';
import { EntityType } from './types';

// Key builders for Scoring Session
const buildSessionPK = (id: string) => `SCORING_SESSION#${id}`;
const buildMetadataSK = () => 'METADATA';
const buildTenantSessionGSI = (tenantId: string) =>
  `TENANT#${tenantId}#SCORING`;

// Key builders for Evaluation Criteria
const buildCriteriaPK = (id: string) => `CRITERIA#${id}`;
const buildTenantCriteriaGSI = (tenantId: string) =>
  `TENANT#${tenantId}#CRITERIA`;

// Convert DynamoDB items to domain objects
function toScoringSession(item: ScoringSessionItem): ScoringSession {
  return {
    id: item.id,
    tenantId: item.tenantId,
    battleId: item.battleId,
    participantId: item.participantId,
    status: item.status,
    totalScore: item.totalScore,
    maxPossibleScore: item.maxPossibleScore,
    submittedAt: item.submittedAt ? new Date(item.submittedAt) : undefined,
    evaluatedAt: item.evaluatedAt ? new Date(item.evaluatedAt) : undefined,
    terraformSnapshot: item.terraformSnapshot,
    evaluationItems: item.evaluationItems,
    feedbacks: item.feedbacks,
    createdAt: new Date(item.CreatedAt),
    updatedAt: new Date(item.UpdatedAt),
  };
}

function toEvaluationCriteria(
  item: EvaluationCriteriaItem
): EvaluationCriteria {
  return {
    id: item.id,
    tenantId: item.tenantId,
    name: item.name,
    description: item.description,
    category: item.category,
    weight: item.weight,
    maxScore: item.maxScore,
    isActive: item.isActive,
    criteriaDetails: item.criteriaDetails,
    createdAt: new Date(item.CreatedAt),
    updatedAt: new Date(item.UpdatedAt),
  };
}

export class ScoringSessionRepository {
  async create(input: CreateScoringSessionInput): Promise<ScoringSession> {
    const client = getDocClient();
    const tableName = getTableName();
    const now = new Date().toISOString();
    const id = ulid();

    const item: ScoringSessionItem = {
      PK: buildSessionPK(id),
      SK: buildMetadataSK(),
      GSI1PK: buildTenantSessionGSI(input.tenantId),
      GSI1SK: now,
      EntityType: EntityType.SCORING_SESSION,
      CreatedAt: now,
      UpdatedAt: now,
      id,
      tenantId: input.tenantId,
      battleId: input.battleId,
      participantId: input.participantId,
      status: 'PENDING',
      totalScore: 0,
      maxPossibleScore: 0,
    };

    await client.send(
      new PutCommand({
        TableName: tableName,
        Item: item,
        ConditionExpression: 'attribute_not_exists(PK)',
      })
    );

    return toScoringSession(item);
  }

  async findById(id: string): Promise<ScoringSession | null> {
    const client = getDocClient();
    const tableName = getTableName();

    const result = await client.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          PK: buildSessionPK(id),
          SK: buildMetadataSK(),
        },
      })
    );

    if (!result.Item) {
      return null;
    }

    return toScoringSession(result.Item as ScoringSessionItem);
  }

  async findByIdAndTenant(
    id: string,
    tenantId: string
  ): Promise<ScoringSession | null> {
    const session = await this.findById(id);
    if (!session || session.tenantId !== tenantId) {
      return null;
    }
    return session;
  }

  async listByTenant(
    tenantId: string,
    options?: {
      status?: EvaluationStatus;
      battleId?: string;
      participantId?: string;
      limit?: number;
      lastKey?: Record<string, unknown>;
    }
  ): Promise<{
    sessions: ScoringSession[];
    lastKey?: Record<string, unknown>;
  }> {
    const client = getDocClient();
    const tableName = getTableName();

    const filterParts: string[] = [];
    const expressionValues: Record<string, unknown> = {
      ':gsi1pk': buildTenantSessionGSI(tenantId),
    };
    const expressionNames: Record<string, string> = {};

    if (options?.status) {
      filterParts.push('#status = :status');
      expressionNames['#status'] = 'status';
      expressionValues[':status'] = options.status;
    }

    if (options?.battleId) {
      filterParts.push('#battleId = :battleId');
      expressionNames['#battleId'] = 'battleId';
      expressionValues[':battleId'] = options.battleId;
    }

    if (options?.participantId) {
      filterParts.push('#participantId = :participantId');
      expressionNames['#participantId'] = 'participantId';
      expressionValues[':participantId'] = options.participantId;
    }

    const result = await client.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :gsi1pk',
        FilterExpression:
          filterParts.length > 0 ? filterParts.join(' AND ') : undefined,
        ExpressionAttributeValues: expressionValues,
        ExpressionAttributeNames:
          Object.keys(expressionNames).length > 0 ? expressionNames : undefined,
        Limit: options?.limit ?? 50,
        ExclusiveStartKey: options?.lastKey,
        ScanIndexForward: false,
      })
    );

    const sessions = (result.Items ?? []).map((item) =>
      toScoringSession(item as ScoringSessionItem)
    );

    return {
      sessions,
      lastKey: result.LastEvaluatedKey,
    };
  }

  async countByTenant(
    tenantId: string,
    status?: EvaluationStatus
  ): Promise<number> {
    const client = getDocClient();
    const tableName = getTableName();

    const expressionValues: Record<string, unknown> = {
      ':gsi1pk': buildTenantSessionGSI(tenantId),
    };
    let filterExpression: string | undefined;

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

  async update(
    id: string,
    input: UpdateScoringSessionInput
  ): Promise<ScoringSession> {
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

    if (input.totalScore !== undefined) {
      updateExpressions.push('#totalScore = :totalScore');
      expressionNames['#totalScore'] = 'totalScore';
      expressionValues[':totalScore'] = input.totalScore;
    }

    if (input.maxPossibleScore !== undefined) {
      updateExpressions.push('#maxPossibleScore = :maxPossibleScore');
      expressionNames['#maxPossibleScore'] = 'maxPossibleScore';
      expressionValues[':maxPossibleScore'] = input.maxPossibleScore;
    }

    if (input.submittedAt !== undefined) {
      updateExpressions.push('#submittedAt = :submittedAt');
      expressionNames['#submittedAt'] = 'submittedAt';
      expressionValues[':submittedAt'] = input.submittedAt.toISOString();
    }

    if (input.evaluatedAt !== undefined) {
      updateExpressions.push('#evaluatedAt = :evaluatedAt');
      expressionNames['#evaluatedAt'] = 'evaluatedAt';
      expressionValues[':evaluatedAt'] = input.evaluatedAt.toISOString();
    }

    if (input.terraformSnapshot !== undefined) {
      updateExpressions.push('#terraformSnapshot = :terraformSnapshot');
      expressionNames['#terraformSnapshot'] = 'terraformSnapshot';
      expressionValues[':terraformSnapshot'] = input.terraformSnapshot;
    }

    if (input.evaluationItems !== undefined) {
      updateExpressions.push('#evaluationItems = :evaluationItems');
      expressionNames['#evaluationItems'] = 'evaluationItems';
      expressionValues[':evaluationItems'] = input.evaluationItems;
    }

    if (input.feedbacks !== undefined) {
      updateExpressions.push('#feedbacks = :feedbacks');
      expressionNames['#feedbacks'] = 'feedbacks';
      expressionValues[':feedbacks'] = input.feedbacks;
    }

    const result = await client.send(
      new UpdateCommand({
        TableName: tableName,
        Key: {
          PK: buildSessionPK(id),
          SK: buildMetadataSK(),
        },
        UpdateExpression: `SET ${updateExpressions.join(', ')}`,
        ExpressionAttributeNames: expressionNames,
        ExpressionAttributeValues: expressionValues,
        ReturnValues: 'ALL_NEW',
        ConditionExpression: 'attribute_exists(PK)',
      })
    );

    return toScoringSession(result.Attributes as ScoringSessionItem);
  }

  async delete(id: string): Promise<void> {
    const client = getDocClient();
    const tableName = getTableName();

    await client.send(
      new DeleteCommand({
        TableName: tableName,
        Key: {
          PK: buildSessionPK(id),
          SK: buildMetadataSK(),
        },
      })
    );
  }
}

export class EvaluationCriteriaRepository {
  async create(
    input: CreateEvaluationCriteriaInput
  ): Promise<EvaluationCriteria> {
    const client = getDocClient();
    const tableName = getTableName();
    const now = new Date().toISOString();
    const id = ulid();

    const item: EvaluationCriteriaItem = {
      PK: buildCriteriaPK(id),
      SK: buildMetadataSK(),
      GSI1PK: buildTenantCriteriaGSI(input.tenantId),
      GSI1SK: now,
      EntityType: EntityType.EVALUATION_CRITERIA,
      CreatedAt: now,
      UpdatedAt: now,
      id,
      tenantId: input.tenantId,
      name: input.name,
      description: input.description,
      category: input.category,
      weight: input.weight ?? 1,
      maxScore: input.maxScore ?? 100,
      isActive: true,
      criteriaDetails: input.criteriaDetails,
    };

    await client.send(
      new PutCommand({
        TableName: tableName,
        Item: item,
        ConditionExpression: 'attribute_not_exists(PK)',
      })
    );

    return toEvaluationCriteria(item);
  }

  async findById(id: string): Promise<EvaluationCriteria | null> {
    const client = getDocClient();
    const tableName = getTableName();

    const result = await client.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          PK: buildCriteriaPK(id),
          SK: buildMetadataSK(),
        },
      })
    );

    if (!result.Item) {
      return null;
    }

    return toEvaluationCriteria(result.Item as EvaluationCriteriaItem);
  }

  async findByIdAndTenant(
    id: string,
    tenantId: string
  ): Promise<EvaluationCriteria | null> {
    const criteria = await this.findById(id);
    if (!criteria || criteria.tenantId !== tenantId) {
      return null;
    }
    return criteria;
  }

  async listByTenant(
    tenantId: string,
    options?: {
      category?: EvaluationCategory;
      activeOnly?: boolean;
      limit?: number;
      lastKey?: Record<string, unknown>;
    }
  ): Promise<{
    criteria: EvaluationCriteria[];
    lastKey?: Record<string, unknown>;
  }> {
    const client = getDocClient();
    const tableName = getTableName();

    const filterParts: string[] = [];
    const expressionValues: Record<string, unknown> = {
      ':gsi1pk': buildTenantCriteriaGSI(tenantId),
    };
    const expressionNames: Record<string, string> = {};

    if (options?.category) {
      filterParts.push('#category = :category');
      expressionNames['#category'] = 'category';
      expressionValues[':category'] = options.category;
    }

    if (options?.activeOnly) {
      filterParts.push('#isActive = :isActive');
      expressionNames['#isActive'] = 'isActive';
      expressionValues[':isActive'] = true;
    }

    const result = await client.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :gsi1pk',
        FilterExpression:
          filterParts.length > 0 ? filterParts.join(' AND ') : undefined,
        ExpressionAttributeValues: expressionValues,
        ExpressionAttributeNames:
          Object.keys(expressionNames).length > 0 ? expressionNames : undefined,
        Limit: options?.limit ?? 50,
        ExclusiveStartKey: options?.lastKey,
        ScanIndexForward: false,
      })
    );

    const criteria = (result.Items ?? []).map((item) =>
      toEvaluationCriteria(item as EvaluationCriteriaItem)
    );

    return {
      criteria,
      lastKey: result.LastEvaluatedKey,
    };
  }

  async countByTenant(tenantId: string, activeOnly?: boolean): Promise<number> {
    const client = getDocClient();
    const tableName = getTableName();

    const expressionValues: Record<string, unknown> = {
      ':gsi1pk': buildTenantCriteriaGSI(tenantId),
    };
    let filterExpression: string | undefined;

    if (activeOnly) {
      filterExpression = '#isActive = :isActive';
      expressionValues[':isActive'] = true;
    }

    const result = await client.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :gsi1pk',
        FilterExpression: filterExpression,
        ExpressionAttributeValues: expressionValues,
        ExpressionAttributeNames: filterExpression
          ? { '#isActive': 'isActive' }
          : undefined,
        Select: 'COUNT',
      })
    );

    return result.Count ?? 0;
  }

  async update(
    id: string,
    input: UpdateEvaluationCriteriaInput
  ): Promise<EvaluationCriteria> {
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

    if (input.description !== undefined) {
      updateExpressions.push('#description = :description');
      expressionNames['#description'] = 'description';
      expressionValues[':description'] = input.description;
    }

    if (input.category !== undefined) {
      updateExpressions.push('#category = :category');
      expressionNames['#category'] = 'category';
      expressionValues[':category'] = input.category;
    }

    if (input.weight !== undefined) {
      updateExpressions.push('#weight = :weight');
      expressionNames['#weight'] = 'weight';
      expressionValues[':weight'] = input.weight;
    }

    if (input.maxScore !== undefined) {
      updateExpressions.push('#maxScore = :maxScore');
      expressionNames['#maxScore'] = 'maxScore';
      expressionValues[':maxScore'] = input.maxScore;
    }

    if (input.isActive !== undefined) {
      updateExpressions.push('#isActive = :isActive');
      expressionNames['#isActive'] = 'isActive';
      expressionValues[':isActive'] = input.isActive;
    }

    if (input.criteriaDetails !== undefined) {
      updateExpressions.push('#criteriaDetails = :criteriaDetails');
      expressionNames['#criteriaDetails'] = 'criteriaDetails';
      expressionValues[':criteriaDetails'] = input.criteriaDetails;
    }

    const result = await client.send(
      new UpdateCommand({
        TableName: tableName,
        Key: {
          PK: buildCriteriaPK(id),
          SK: buildMetadataSK(),
        },
        UpdateExpression: `SET ${updateExpressions.join(', ')}`,
        ExpressionAttributeNames: expressionNames,
        ExpressionAttributeValues: expressionValues,
        ReturnValues: 'ALL_NEW',
        ConditionExpression: 'attribute_exists(PK)',
      })
    );

    return toEvaluationCriteria(result.Attributes as EvaluationCriteriaItem);
  }

  async delete(id: string): Promise<void> {
    const client = getDocClient();
    const tableName = getTableName();

    await client.send(
      new DeleteCommand({
        TableName: tableName,
        Key: {
          PK: buildCriteriaPK(id),
          SK: buildMetadataSK(),
        },
      })
    );
  }
}
