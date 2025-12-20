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
  ProblemTemplate,
  ProblemTemplateItem,
  CreateProblemTemplateInput,
  UpdateProblemTemplateInput,
  ProblemTemplateStatus,
  ProblemType,
  ProblemCategory,
  DifficultyLevel,
} from './types';
import { EntityType } from './types';

// Key builders
const buildTemplatePK = (id: string) => `PROBLEM_TEMPLATE#${id}`;
const buildMetadataSK = () => 'METADATA';
const buildStatusGSI = (status: ProblemTemplateStatus) =>
  `PROBLEM_TEMPLATE#${status}`;

// Convert DynamoDB item to domain object
function toDomain(item: ProblemTemplateItem): ProblemTemplate {
  return {
    id: item.id,
    name: item.name,
    description: item.description,
    type: item.type,
    category: item.category,
    difficulty: item.difficulty,
    status: item.status,
    variables: item.variables,
    overviewTemplate: item.overviewTemplate,
    objectivesTemplate: item.objectivesTemplate,
    hintsTemplate: item.hintsTemplate,
    prerequisites: item.prerequisites,
    estimatedTimeMinutes: item.estimatedTimeMinutes,
    providers: item.providers,
    templateType: item.templateType,
    templateContent: item.templateContent,
    regions: item.regions,
    deploymentTimeout: item.deploymentTimeout,
    scoringType: item.scoringType,
    criteriaTemplate: item.criteriaTemplate,
    scoringTimeout: item.scoringTimeout,
    tags: item.tags,
    author: item.author,
    version: item.version,
    usageCount: item.usageCount,
    createdAt: new Date(item.CreatedAt),
    updatedAt: new Date(item.UpdatedAt),
  };
}

export class ProblemTemplateRepository {
  async create(input: CreateProblemTemplateInput): Promise<ProblemTemplate> {
    const client = getDocClient();
    const tableName = getTableName();
    const now = new Date().toISOString();
    const id = ulid();

    const item: ProblemTemplateItem = {
      PK: buildTemplatePK(id),
      SK: buildMetadataSK(),
      GSI1PK: buildStatusGSI('DRAFT'),
      GSI1SK: now,
      EntityType: EntityType.PROBLEM_TEMPLATE,
      CreatedAt: now,
      UpdatedAt: now,
      id,
      name: input.name,
      description: input.description,
      type: input.type,
      category: input.category,
      difficulty: input.difficulty,
      status: 'DRAFT',
      variables: [],
      overviewTemplate: input.overviewTemplate,
      objectivesTemplate: input.objectivesTemplate ?? [],
      hintsTemplate: input.hintsTemplate ?? [],
      prerequisites: input.prerequisites ?? [],
      estimatedTimeMinutes: input.estimatedTimeMinutes,
      providers: input.providers,
      templateType: input.templateType,
      templateContent: input.templateContent,
      regions: input.regions ?? {},
      deploymentTimeout: input.deploymentTimeout ?? 60,
      scoringType: input.scoringType,
      criteriaTemplate: input.criteriaTemplate ?? [],
      scoringTimeout: input.scoringTimeout ?? 30,
      tags: input.tags ?? [],
      author: input.author,
      version: '1.0.0',
      usageCount: 0,
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

  async findById(id: string): Promise<ProblemTemplate | null> {
    const client = getDocClient();
    const tableName = getTableName();

    const result = await client.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          PK: buildTemplatePK(id),
          SK: buildMetadataSK(),
        },
      })
    );

    if (!result.Item) {
      return null;
    }

    return toDomain(result.Item as ProblemTemplateItem);
  }

  async list(options?: {
    status?: ProblemTemplateStatus;
    type?: ProblemType;
    category?: ProblemCategory;
    difficulty?: DifficultyLevel;
    limit?: number;
    lastKey?: Record<string, unknown>;
  }): Promise<{
    templates: ProblemTemplate[];
    lastKey?: Record<string, unknown>;
  }> {
    const client = getDocClient();
    const tableName = getTableName();

    // If status is specified, use GSI1
    if (options?.status) {
      const filterParts: string[] = [];
      const expressionValues: Record<string, unknown> = {
        ':gsi1pk': buildStatusGSI(options.status),
      };
      const expressionNames: Record<string, string> = {};

      if (options.type) {
        filterParts.push('#type = :type');
        expressionNames['#type'] = 'type';
        expressionValues[':type'] = options.type;
      }

      if (options.category) {
        filterParts.push('#category = :category');
        expressionNames['#category'] = 'category';
        expressionValues[':category'] = options.category;
      }

      if (options.difficulty) {
        filterParts.push('#difficulty = :difficulty');
        expressionNames['#difficulty'] = 'difficulty';
        expressionValues[':difficulty'] = options.difficulty;
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
            Object.keys(expressionNames).length > 0
              ? expressionNames
              : undefined,
          Limit: options?.limit ?? 50,
          ExclusiveStartKey: options?.lastKey,
          ScanIndexForward: false,
        })
      );

      const templates = (result.Items ?? []).map((item) =>
        toDomain(item as ProblemTemplateItem)
      );

      return {
        templates,
        lastKey: result.LastEvaluatedKey,
      };
    }

    // Otherwise, use GSI2 with EntityType
    const filterParts: string[] = [];
    const expressionValues: Record<string, unknown> = {
      ':entityType': EntityType.PROBLEM_TEMPLATE,
    };
    const expressionNames: Record<string, string> = {};

    if (options?.type) {
      filterParts.push('#type = :type');
      expressionNames['#type'] = 'type';
      expressionValues[':type'] = options.type;
    }

    if (options?.category) {
      filterParts.push('#category = :category');
      expressionNames['#category'] = 'category';
      expressionValues[':category'] = options.category;
    }

    if (options?.difficulty) {
      filterParts.push('#difficulty = :difficulty');
      expressionNames['#difficulty'] = 'difficulty';
      expressionValues[':difficulty'] = options.difficulty;
    }

    const result = await client.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: 'GSI2',
        KeyConditionExpression: 'EntityType = :entityType',
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

    const templates = (result.Items ?? []).map((item) =>
      toDomain(item as ProblemTemplateItem)
    );

    return {
      templates,
      lastKey: result.LastEvaluatedKey,
    };
  }

  async update(
    id: string,
    input: UpdateProblemTemplateInput
  ): Promise<ProblemTemplate> {
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

    if (input.status !== undefined) {
      updateExpressions.push('#status = :status');
      expressionNames['#status'] = 'status';
      expressionValues[':status'] = input.status;
      // Also update GSI1PK for status-based queries
      updateExpressions.push('GSI1PK = :gsi1pk');
      expressionValues[':gsi1pk'] = buildStatusGSI(input.status);
    }

    if (input.overviewTemplate !== undefined) {
      updateExpressions.push('#overviewTemplate = :overviewTemplate');
      expressionNames['#overviewTemplate'] = 'overviewTemplate';
      expressionValues[':overviewTemplate'] = input.overviewTemplate;
    }

    if (input.objectivesTemplate !== undefined) {
      updateExpressions.push('#objectivesTemplate = :objectivesTemplate');
      expressionNames['#objectivesTemplate'] = 'objectivesTemplate';
      expressionValues[':objectivesTemplate'] = input.objectivesTemplate;
    }

    if (input.hintsTemplate !== undefined) {
      updateExpressions.push('#hintsTemplate = :hintsTemplate');
      expressionNames['#hintsTemplate'] = 'hintsTemplate';
      expressionValues[':hintsTemplate'] = input.hintsTemplate;
    }

    if (input.templateContent !== undefined) {
      updateExpressions.push('#templateContent = :templateContent');
      expressionNames['#templateContent'] = 'templateContent';
      expressionValues[':templateContent'] = input.templateContent;
    }

    if (input.criteriaTemplate !== undefined) {
      updateExpressions.push('#criteriaTemplate = :criteriaTemplate');
      expressionNames['#criteriaTemplate'] = 'criteriaTemplate';
      expressionValues[':criteriaTemplate'] = input.criteriaTemplate;
    }

    if (input.tags !== undefined) {
      updateExpressions.push('#tags = :tags');
      expressionNames['#tags'] = 'tags';
      expressionValues[':tags'] = input.tags;
    }

    const result = await client.send(
      new UpdateCommand({
        TableName: tableName,
        Key: {
          PK: buildTemplatePK(id),
          SK: buildMetadataSK(),
        },
        UpdateExpression: `SET ${updateExpressions.join(', ')}`,
        ExpressionAttributeNames: expressionNames,
        ExpressionAttributeValues: expressionValues,
        ReturnValues: 'ALL_NEW',
        ConditionExpression: 'attribute_exists(PK)',
      })
    );

    return toDomain(result.Attributes as ProblemTemplateItem);
  }

  async incrementUsageCount(id: string): Promise<void> {
    const client = getDocClient();
    const tableName = getTableName();
    const now = new Date().toISOString();

    await client.send(
      new UpdateCommand({
        TableName: tableName,
        Key: {
          PK: buildTemplatePK(id),
          SK: buildMetadataSK(),
        },
        UpdateExpression:
          'SET #usageCount = #usageCount + :one, #updatedAt = :updatedAt',
        ExpressionAttributeNames: {
          '#usageCount': 'usageCount',
          '#updatedAt': 'UpdatedAt',
        },
        ExpressionAttributeValues: {
          ':one': 1,
          ':updatedAt': now,
        },
        ConditionExpression: 'attribute_exists(PK)',
      })
    );
  }

  async delete(id: string): Promise<void> {
    const client = getDocClient();
    const tableName = getTableName();

    await client.send(
      new DeleteCommand({
        TableName: tableName,
        Key: {
          PK: buildTemplatePK(id),
          SK: buildMetadataSK(),
        },
      })
    );
  }

  async count(status?: ProblemTemplateStatus): Promise<number> {
    const client = getDocClient();
    const tableName = getTableName();

    if (status) {
      const result = await client.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: 'GSI1',
          KeyConditionExpression: 'GSI1PK = :gsi1pk',
          ExpressionAttributeValues: {
            ':gsi1pk': buildStatusGSI(status),
          },
          Select: 'COUNT',
        })
      );
      return result.Count ?? 0;
    }

    const result = await client.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: 'GSI2',
        KeyConditionExpression: 'EntityType = :entityType',
        ExpressionAttributeValues: {
          ':entityType': EntityType.PROBLEM_TEMPLATE,
        },
        Select: 'COUNT',
      })
    );
    return result.Count ?? 0;
  }
}
