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
  Event,
  EventItem,
  CreateEventInput,
  UpdateEventInput,
  EventStatus,
  EventProblem,
  EventProblemItem,
  ProblemType,
} from './types';
import { EntityType } from './types';

// Key builders
const buildEventPK = (id: string) => `EVENT#${id}`;
const buildMetadataSK = () => 'METADATA';
const buildProblemSK = (problemId: string) => `PROBLEM#${problemId}`;
const buildTenantGSI = (tenantId: string) => `TENANT#${tenantId}`;
const buildStatusGSI = (tenantId: string, status: EventStatus) =>
  `TENANT#${tenantId}#STATUS#${status}`;
const buildExternalIdGSI = (externalId: string) => `EXTERNAL#${externalId}`;

// Convert DynamoDB item to domain object
function toDomain(item: EventItem): Event {
  return {
    id: item.id,
    externalId: item.externalId,
    tenantId: item.tenantId,
    name: item.name,
    type: item.type,
    status: item.status,
    startTime: new Date(item.startTime),
    endTime: new Date(item.endTime),
    timezone: item.timezone,
    participantType: item.participantType,
    maxParticipants: item.maxParticipants,
    minTeamSize: item.minTeamSize,
    maxTeamSize: item.maxTeamSize,
    registrationDeadline: item.registrationDeadline
      ? new Date(item.registrationDeadline)
      : undefined,
    cloudProvider: item.cloudProvider,
    regions: item.regions,
    scoringType: item.scoringType,
    scoringIntervalMinutes: item.scoringIntervalMinutes,
    leaderboardVisible: item.leaderboardVisible,
    freezeLeaderboardMinutes: item.freezeLeaderboardMinutes,
    createdBy: item.createdBy,
    createdAt: new Date(item.CreatedAt),
    updatedAt: new Date(item.UpdatedAt),
  };
}

// Convert EventProblem item to domain object
function toEventProblemDomain(item: EventProblemItem): EventProblem {
  return {
    eventId: item.eventId,
    problemId: item.problemId,
    order: item.order,
    unlockTime: item.unlockTime ? new Date(item.unlockTime) : undefined,
    pointMultiplier: item.pointMultiplier,
  };
}

export interface EventFilterOptions {
  tenantId?: string;
  type?: ProblemType;
  status?: EventStatus | EventStatus[];
  startAfter?: Date;
  startBefore?: Date;
  offset?: number;
  limit?: number;
}

export class EventRepository {
  async create(input: CreateEventInput): Promise<Event> {
    const client = getDocClient();
    const tableName = getTableName();
    const now = new Date().toISOString();
    const id = ulid();
    const externalId = input.externalId || `evt-${Date.now()}`;

    const item: EventItem = {
      PK: buildEventPK(id),
      SK: buildMetadataSK(),
      GSI1PK: buildTenantGSI(input.tenantId),
      GSI1SK: input.startTime.toISOString(),
      EntityType: EntityType.EVENT,
      CreatedAt: now,
      UpdatedAt: now,
      id,
      externalId,
      tenantId: input.tenantId,
      name: input.name,
      type: input.type,
      status: input.status || 'DRAFT',
      startTime: input.startTime.toISOString(),
      endTime: input.endTime.toISOString(),
      timezone: input.timezone || 'Asia/Tokyo',
      participantType: input.participantType,
      maxParticipants: input.maxParticipants,
      minTeamSize: input.minTeamSize,
      maxTeamSize: input.maxTeamSize,
      registrationDeadline: input.registrationDeadline?.toISOString(),
      cloudProvider: input.cloudProvider,
      regions: input.regions,
      scoringType: input.scoringType,
      scoringIntervalMinutes: input.scoringIntervalMinutes,
      leaderboardVisible: input.leaderboardVisible ?? true,
      freezeLeaderboardMinutes: input.freezeLeaderboardMinutes,
      createdBy: input.createdBy,
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

  async findById(id: string): Promise<Event | null> {
    const client = getDocClient();
    const tableName = getTableName();

    const result = await client.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          PK: buildEventPK(id),
          SK: buildMetadataSK(),
        },
      })
    );

    if (!result.Item) {
      return null;
    }

    return toDomain(result.Item as EventItem);
  }

  async findByExternalId(externalId: string): Promise<Event | null> {
    const client = getDocClient();
    const tableName = getTableName();

    // Query GSI2 by EntityType and filter by externalId
    const result = await client.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: 'GSI2',
        KeyConditionExpression: 'EntityType = :entityType',
        FilterExpression: 'externalId = :externalId',
        ExpressionAttributeValues: {
          ':entityType': EntityType.EVENT,
          ':externalId': externalId,
        },
        Limit: 1,
      })
    );

    if (!result.Items || result.Items.length === 0) {
      return null;
    }

    return toDomain(result.Items[0] as EventItem);
  }

  async findByTenant(
    tenantId: string,
    options?: Omit<EventFilterOptions, 'tenantId'>
  ): Promise<Event[]> {
    const client = getDocClient();
    const tableName = getTableName();

    const filterParts: string[] = [];
    const expressionValues: Record<string, unknown> = {
      ':gsi1pk': buildTenantGSI(tenantId),
    };
    const expressionNames: Record<string, string> = {};

    if (options?.type) {
      filterParts.push('#type = :type');
      expressionNames['#type'] = 'type';
      expressionValues[':type'] = options.type;
    }

    if (options?.status) {
      const statuses = Array.isArray(options.status)
        ? options.status
        : [options.status];
      if (statuses.length === 1) {
        filterParts.push('#status = :status');
        expressionNames['#status'] = 'status';
        expressionValues[':status'] = statuses[0];
      } else {
        const statusPlaceholders = statuses.map((_, i) => `:status${i}`);
        filterParts.push(`#status IN (${statusPlaceholders.join(', ')})`);
        expressionNames['#status'] = 'status';
        statuses.forEach((s, i) => {
          expressionValues[`:status${i}`] = s;
        });
      }
    }

    if (options?.startAfter) {
      filterParts.push('startTime >= :startAfter');
      expressionValues[':startAfter'] = options.startAfter.toISOString();
    }

    if (options?.startBefore) {
      filterParts.push('startTime <= :startBefore');
      expressionValues[':startBefore'] = options.startBefore.toISOString();
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
        ScanIndexForward: false,
      })
    );

    let events = (result.Items ?? []).map((item) =>
      toDomain(item as EventItem)
    );

    // Apply offset if provided
    if (options?.offset) {
      events = events.slice(options.offset);
    }

    return events;
  }

  async list(options?: EventFilterOptions): Promise<{
    events: Event[];
    lastKey?: Record<string, unknown>;
  }> {
    const client = getDocClient();
    const tableName = getTableName();

    // If tenantId is specified, use GSI1
    if (options?.tenantId) {
      const events = await this.findByTenant(options.tenantId, options);
      return { events };
    }

    // Otherwise, query by EntityType on GSI2
    const filterParts: string[] = [];
    const expressionValues: Record<string, unknown> = {
      ':entityType': EntityType.EVENT,
    };
    const expressionNames: Record<string, string> = {};

    if (options?.type) {
      filterParts.push('#type = :type');
      expressionNames['#type'] = 'type';
      expressionValues[':type'] = options.type;
    }

    if (options?.status) {
      const statuses = Array.isArray(options.status)
        ? options.status
        : [options.status];
      if (statuses.length === 1) {
        filterParts.push('#status = :status');
        expressionNames['#status'] = 'status';
        expressionValues[':status'] = statuses[0];
      } else {
        const statusPlaceholders = statuses.map((_, i) => `:status${i}`);
        filterParts.push(`#status IN (${statusPlaceholders.join(', ')})`);
        expressionNames['#status'] = 'status';
        statuses.forEach((s, i) => {
          expressionValues[`:status${i}`] = s;
        });
      }
    }

    if (options?.startAfter) {
      filterParts.push('startTime >= :startAfter');
      expressionValues[':startAfter'] = options.startAfter.toISOString();
    }

    if (options?.startBefore) {
      filterParts.push('startTime <= :startBefore');
      expressionValues[':startBefore'] = options.startBefore.toISOString();
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
        ScanIndexForward: false,
      })
    );

    let events = (result.Items ?? []).map((item) =>
      toDomain(item as EventItem)
    );

    // Apply offset if provided
    if (options?.offset) {
      events = events.slice(options.offset);
    }

    return {
      events,
      lastKey: result.LastEvaluatedKey,
    };
  }

  async update(id: string, input: UpdateEventInput): Promise<Event> {
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

    if (input.startTime !== undefined) {
      updateExpressions.push('#startTime = :startTime');
      expressionNames['#startTime'] = 'startTime';
      expressionValues[':startTime'] = input.startTime.toISOString();
      // Also update GSI1SK for proper sorting
      updateExpressions.push('GSI1SK = :gsi1sk');
      expressionValues[':gsi1sk'] = input.startTime.toISOString();
    }

    if (input.endTime !== undefined) {
      updateExpressions.push('#endTime = :endTime');
      expressionNames['#endTime'] = 'endTime';
      expressionValues[':endTime'] = input.endTime.toISOString();
    }

    if (input.timezone !== undefined) {
      updateExpressions.push('#timezone = :timezone');
      expressionNames['#timezone'] = 'timezone';
      expressionValues[':timezone'] = input.timezone;
    }

    if (input.participantType !== undefined) {
      updateExpressions.push('#participantType = :participantType');
      expressionNames['#participantType'] = 'participantType';
      expressionValues[':participantType'] = input.participantType;
    }

    if (input.maxParticipants !== undefined) {
      updateExpressions.push('#maxParticipants = :maxParticipants');
      expressionNames['#maxParticipants'] = 'maxParticipants';
      expressionValues[':maxParticipants'] = input.maxParticipants;
    }

    if (input.minTeamSize !== undefined) {
      updateExpressions.push('#minTeamSize = :minTeamSize');
      expressionNames['#minTeamSize'] = 'minTeamSize';
      expressionValues[':minTeamSize'] = input.minTeamSize;
    }

    if (input.maxTeamSize !== undefined) {
      updateExpressions.push('#maxTeamSize = :maxTeamSize');
      expressionNames['#maxTeamSize'] = 'maxTeamSize';
      expressionValues[':maxTeamSize'] = input.maxTeamSize;
    }

    if (input.registrationDeadline !== undefined) {
      updateExpressions.push('#registrationDeadline = :registrationDeadline');
      expressionNames['#registrationDeadline'] = 'registrationDeadline';
      expressionValues[':registrationDeadline'] =
        input.registrationDeadline.toISOString();
    }

    if (input.cloudProvider !== undefined) {
      updateExpressions.push('#cloudProvider = :cloudProvider');
      expressionNames['#cloudProvider'] = 'cloudProvider';
      expressionValues[':cloudProvider'] = input.cloudProvider;
    }

    if (input.regions !== undefined) {
      updateExpressions.push('#regions = :regions');
      expressionNames['#regions'] = 'regions';
      expressionValues[':regions'] = input.regions;
    }

    if (input.scoringType !== undefined) {
      updateExpressions.push('#scoringType = :scoringType');
      expressionNames['#scoringType'] = 'scoringType';
      expressionValues[':scoringType'] = input.scoringType;
    }

    if (input.scoringIntervalMinutes !== undefined) {
      updateExpressions.push(
        '#scoringIntervalMinutes = :scoringIntervalMinutes'
      );
      expressionNames['#scoringIntervalMinutes'] = 'scoringIntervalMinutes';
      expressionValues[':scoringIntervalMinutes'] =
        input.scoringIntervalMinutes;
    }

    if (input.leaderboardVisible !== undefined) {
      updateExpressions.push('#leaderboardVisible = :leaderboardVisible');
      expressionNames['#leaderboardVisible'] = 'leaderboardVisible';
      expressionValues[':leaderboardVisible'] = input.leaderboardVisible;
    }

    if (input.freezeLeaderboardMinutes !== undefined) {
      updateExpressions.push(
        '#freezeLeaderboardMinutes = :freezeLeaderboardMinutes'
      );
      expressionNames['#freezeLeaderboardMinutes'] = 'freezeLeaderboardMinutes';
      expressionValues[':freezeLeaderboardMinutes'] =
        input.freezeLeaderboardMinutes;
    }

    const result = await client.send(
      new UpdateCommand({
        TableName: tableName,
        Key: {
          PK: buildEventPK(id),
          SK: buildMetadataSK(),
        },
        UpdateExpression: `SET ${updateExpressions.join(', ')}`,
        ExpressionAttributeNames: expressionNames,
        ExpressionAttributeValues: expressionValues,
        ReturnValues: 'ALL_NEW',
        ConditionExpression: 'attribute_exists(PK)',
      })
    );

    return toDomain(result.Attributes as EventItem);
  }

  async updateStatus(id: string, status: EventStatus): Promise<void> {
    const client = getDocClient();
    const tableName = getTableName();
    const now = new Date().toISOString();

    await client.send(
      new UpdateCommand({
        TableName: tableName,
        Key: {
          PK: buildEventPK(id),
          SK: buildMetadataSK(),
        },
        UpdateExpression: 'SET #status = :status, #updatedAt = :updatedAt',
        ExpressionAttributeNames: {
          '#status': 'status',
          '#updatedAt': 'UpdatedAt',
        },
        ExpressionAttributeValues: {
          ':status': status,
          ':updatedAt': now,
        },
        ConditionExpression: 'attribute_exists(PK)',
      })
    );
  }

  async delete(id: string): Promise<void> {
    const client = getDocClient();
    const tableName = getTableName();

    // First, get all EventProblems for this event and delete them
    const problems = await this.getEventProblems(id);

    if (problems.length > 0) {
      // Use transaction to delete all problems
      const deleteRequests = problems.map((p) => ({
        Delete: {
          TableName: tableName,
          Key: {
            PK: buildEventPK(id),
            SK: buildProblemSK(p.problemId),
          },
        },
      }));

      // Add the event itself
      deleteRequests.push({
        Delete: {
          TableName: tableName,
          Key: {
            PK: buildEventPK(id),
            SK: buildMetadataSK(),
          },
        },
      });

      await client.send(
        new TransactWriteCommand({
          TransactItems: deleteRequests,
        })
      );
    } else {
      // Just delete the event
      await client.send(
        new DeleteCommand({
          TableName: tableName,
          Key: {
            PK: buildEventPK(id),
            SK: buildMetadataSK(),
          },
        })
      );
    }
  }

  async count(options?: EventFilterOptions): Promise<number> {
    const client = getDocClient();
    const tableName = getTableName();

    // If tenantId is specified, use GSI1
    if (options?.tenantId) {
      const filterParts: string[] = [];
      const expressionValues: Record<string, unknown> = {
        ':gsi1pk': buildTenantGSI(options.tenantId),
      };
      const expressionNames: Record<string, string> = {};

      if (options.type) {
        filterParts.push('#type = :type');
        expressionNames['#type'] = 'type';
        expressionValues[':type'] = options.type;
      }

      if (options.status) {
        const statuses = Array.isArray(options.status)
          ? options.status
          : [options.status];
        if (statuses.length === 1) {
          filterParts.push('#status = :status');
          expressionNames['#status'] = 'status';
          expressionValues[':status'] = statuses[0];
        } else {
          const statusPlaceholders = statuses.map((_, i) => `:status${i}`);
          filterParts.push(`#status IN (${statusPlaceholders.join(', ')})`);
          expressionNames['#status'] = 'status';
          statuses.forEach((s, i) => {
            expressionValues[`:status${i}`] = s;
          });
        }
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
          Select: 'COUNT',
        })
      );

      return result.Count ?? 0;
    }

    // Otherwise, query by EntityType on GSI2
    const filterParts: string[] = [];
    const expressionValues: Record<string, unknown> = {
      ':entityType': EntityType.EVENT,
    };
    const expressionNames: Record<string, string> = {};

    if (options?.type) {
      filterParts.push('#type = :type');
      expressionNames['#type'] = 'type';
      expressionValues[':type'] = options.type;
    }

    if (options?.status) {
      const statuses = Array.isArray(options.status)
        ? options.status
        : [options.status];
      if (statuses.length === 1) {
        filterParts.push('#status = :status');
        expressionNames['#status'] = 'status';
        expressionValues[':status'] = statuses[0];
      } else {
        const statusPlaceholders = statuses.map((_, i) => `:status${i}`);
        filterParts.push(`#status IN (${statusPlaceholders.join(', ')})`);
        expressionNames['#status'] = 'status';
        statuses.forEach((s, i) => {
          expressionValues[`:status${i}`] = s;
        });
      }
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
        Select: 'COUNT',
      })
    );

    return result.Count ?? 0;
  }

  // EventProblem operations
  async getEventProblems(eventId: string): Promise<EventProblem[]> {
    const client = getDocClient();
    const tableName = getTableName();

    const result = await client.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
        ExpressionAttributeValues: {
          ':pk': buildEventPK(eventId),
          ':skPrefix': 'PROBLEM#',
        },
      })
    );

    const problems = (result.Items ?? []).map((item) =>
      toEventProblemDomain(item as EventProblemItem)
    );

    // Sort by order
    return problems.sort((a, b) => a.order - b.order);
  }

  async addProblemToEvent(
    eventId: string,
    problemId: string,
    options?: {
      order?: number;
      unlockTime?: Date;
      pointMultiplier?: number;
    }
  ): Promise<EventProblem> {
    const client = getDocClient();
    const tableName = getTableName();
    const now = new Date().toISOString();

    // Get existing problems to determine order if not provided
    let order = options?.order;
    if (order === undefined) {
      const existingProblems = await this.getEventProblems(eventId);
      order = existingProblems.length + 1;
    }

    const item: EventProblemItem = {
      PK: buildEventPK(eventId),
      SK: buildProblemSK(problemId),
      EntityType: EntityType.EVENT_PROBLEM,
      CreatedAt: now,
      UpdatedAt: now,
      eventId,
      problemId,
      order,
      unlockTime: options?.unlockTime?.toISOString(),
      pointMultiplier: options?.pointMultiplier ?? 1,
    };

    await client.send(
      new PutCommand({
        TableName: tableName,
        Item: item,
      })
    );

    return toEventProblemDomain(item);
  }

  async updateEventProblem(
    eventId: string,
    problemId: string,
    updates: {
      order?: number;
      unlockTime?: Date;
      pointMultiplier?: number;
    }
  ): Promise<EventProblem> {
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

    if (updates.order !== undefined) {
      updateExpressions.push('#order = :order');
      expressionNames['#order'] = 'order';
      expressionValues[':order'] = updates.order;
    }

    if (updates.unlockTime !== undefined) {
      updateExpressions.push('#unlockTime = :unlockTime');
      expressionNames['#unlockTime'] = 'unlockTime';
      expressionValues[':unlockTime'] = updates.unlockTime.toISOString();
    }

    if (updates.pointMultiplier !== undefined) {
      updateExpressions.push('#pointMultiplier = :pointMultiplier');
      expressionNames['#pointMultiplier'] = 'pointMultiplier';
      expressionValues[':pointMultiplier'] = updates.pointMultiplier;
    }

    const result = await client.send(
      new UpdateCommand({
        TableName: tableName,
        Key: {
          PK: buildEventPK(eventId),
          SK: buildProblemSK(problemId),
        },
        UpdateExpression: `SET ${updateExpressions.join(', ')}`,
        ExpressionAttributeNames: expressionNames,
        ExpressionAttributeValues: expressionValues,
        ReturnValues: 'ALL_NEW',
        ConditionExpression: 'attribute_exists(PK)',
      })
    );

    return toEventProblemDomain(result.Attributes as EventProblemItem);
  }

  async removeProblemFromEvent(
    eventId: string,
    problemId: string
  ): Promise<void> {
    const client = getDocClient();
    const tableName = getTableName();

    await client.send(
      new DeleteCommand({
        TableName: tableName,
        Key: {
          PK: buildEventPK(eventId),
          SK: buildProblemSK(problemId),
        },
      })
    );
  }

  async getEventWithProblems(eventId: string): Promise<{
    event: Event;
    problems: EventProblem[];
  } | null> {
    const event = await this.findById(eventId);
    if (!event) {
      return null;
    }

    const problems = await this.getEventProblems(eventId);

    return { event, problems };
  }
}
