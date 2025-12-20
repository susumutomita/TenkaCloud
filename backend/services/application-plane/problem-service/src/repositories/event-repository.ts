/**
 * DynamoDB Event Repository
 *
 * DynamoDB を使用したイベントリポジトリ実装
 * 共有パッケージの EventRepository をラップして、
 * problem-service の型に変換するアダプター
 */

import {
  EventRepository as DynamoDBEventRepository,
  type Event as DynamoEvent,
  type CreateEventInput as DynamoCreateEventInput,
  type UpdateEventInput as DynamoUpdateEventInput,
  type EventStatus as DynamoEventStatus,
  type ProblemType as DynamoProblemType,
  type ParticipantType as DynamoParticipantType,
  type ScoringType as DynamoScoringType,
  type CloudProvider as DynamoCloudProvider,
  type EventProblem as DynamoEventProblem,
  type EventFilterOptions as DynamoEventFilterOptions,
} from '@tenkacloud/dynamodb';
import { eventRepository } from '../lib/dynamodb';
import type {
  IEventRepository,
  EventFilterOptions,
} from '../events/repository';
import type { Event, EventStatus, EventType } from '../types';

// =============================================================================
// 型変換ユーティリティ (lowercase <-> UPPERCASE)
// =============================================================================

function toDynamoEventStatus(status: EventStatus): DynamoEventStatus {
  const map: Record<EventStatus, DynamoEventStatus> = {
    draft: 'DRAFT',
    scheduled: 'SCHEDULED',
    active: 'ACTIVE',
    paused: 'PAUSED',
    completed: 'COMPLETED',
    cancelled: 'CANCELLED',
  };
  return map[status];
}

function fromDynamoEventStatus(status: DynamoEventStatus): EventStatus {
  return status.toLowerCase() as EventStatus;
}

function toDynamoProblemType(type: EventType): DynamoProblemType {
  const map: Record<EventType, DynamoProblemType> = {
    gameday: 'GAMEDAY',
    jam: 'JAM',
  };
  return map[type];
}

function fromDynamoProblemType(type: DynamoProblemType): EventType {
  return type.toLowerCase() as EventType;
}

function toDynamoParticipantType(
  type: 'individual' | 'team'
): DynamoParticipantType {
  const map: Record<'individual' | 'team', DynamoParticipantType> = {
    individual: 'INDIVIDUAL',
    team: 'TEAM',
  };
  return map[type];
}

function fromDynamoParticipantType(
  type: DynamoParticipantType
): 'individual' | 'team' {
  return type.toLowerCase() as 'individual' | 'team';
}

function toDynamoScoringType(type: 'realtime' | 'batch'): DynamoScoringType {
  const map: Record<'realtime' | 'batch', DynamoScoringType> = {
    realtime: 'REALTIME',
    batch: 'BATCH',
  };
  return map[type];
}

function fromDynamoScoringType(type: DynamoScoringType): 'realtime' | 'batch' {
  return type.toLowerCase() as 'realtime' | 'batch';
}

function toDynamoCloudProvider(
  provider: 'aws' | 'gcp' | 'azure' | 'local'
): DynamoCloudProvider {
  const map: Record<'aws' | 'gcp' | 'azure' | 'local', DynamoCloudProvider> = {
    aws: 'AWS',
    gcp: 'GCP',
    azure: 'AZURE',
    local: 'LOCAL',
  };
  return map[provider];
}

function fromDynamoCloudProvider(
  provider: DynamoCloudProvider
): 'aws' | 'gcp' | 'azure' | 'local' {
  return provider.toLowerCase() as 'aws' | 'gcp' | 'azure' | 'local';
}

/**
 * DynamoDB Event を内部型に変換
 */
function toEvent(dynamoEvent: DynamoEvent): Event {
  return {
    id: dynamoEvent.id,
    externalId: dynamoEvent.externalId,
    tenantId: dynamoEvent.tenantId,
    name: dynamoEvent.name,
    type: fromDynamoProblemType(dynamoEvent.type),
    status: fromDynamoEventStatus(dynamoEvent.status),
    startTime: dynamoEvent.startTime,
    endTime: dynamoEvent.endTime,
    timezone: dynamoEvent.timezone,
    participantType: fromDynamoParticipantType(dynamoEvent.participantType),
    maxParticipants: dynamoEvent.maxParticipants,
    minTeamSize: dynamoEvent.minTeamSize,
    maxTeamSize: dynamoEvent.maxTeamSize,
    registrationDeadline: dynamoEvent.registrationDeadline,
    cloudProvider: fromDynamoCloudProvider(dynamoEvent.cloudProvider),
    regions: dynamoEvent.regions,
    scoringType: fromDynamoScoringType(dynamoEvent.scoringType),
    scoringIntervalMinutes: dynamoEvent.scoringIntervalMinutes,
    leaderboardVisible: dynamoEvent.leaderboardVisible,
    freezeLeaderboardMinutes: dynamoEvent.freezeLeaderboardMinutes,
    createdBy: dynamoEvent.createdBy,
    createdAt: dynamoEvent.createdAt,
    updatedAt: dynamoEvent.updatedAt,
  };
}

/**
 * DynamoDB Event Repository 実装
 */
export class DynamoEventRepository implements IEventRepository {
  private repo: DynamoDBEventRepository;

  constructor(repo?: DynamoDBEventRepository) {
    this.repo = repo ?? eventRepository;
  }

  async create(
    eventData: Omit<Event, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<Event> {
    const input: DynamoCreateEventInput = {
      externalId: eventData.externalId,
      tenantId: eventData.tenantId,
      name: eventData.name,
      type: toDynamoProblemType(eventData.type),
      status: eventData.status
        ? toDynamoEventStatus(eventData.status)
        : undefined,
      startTime: eventData.startTime,
      endTime: eventData.endTime,
      timezone: eventData.timezone,
      participantType: toDynamoParticipantType(eventData.participantType),
      maxParticipants: eventData.maxParticipants,
      minTeamSize: eventData.minTeamSize,
      maxTeamSize: eventData.maxTeamSize,
      registrationDeadline: eventData.registrationDeadline,
      cloudProvider: toDynamoCloudProvider(eventData.cloudProvider),
      regions: eventData.regions,
      scoringType: toDynamoScoringType(eventData.scoringType),
      scoringIntervalMinutes: eventData.scoringIntervalMinutes,
      leaderboardVisible: eventData.leaderboardVisible,
      freezeLeaderboardMinutes: eventData.freezeLeaderboardMinutes,
      createdBy: eventData.createdBy,
    };

    const created = await this.repo.create(input);
    return toEvent(created);
  }

  async update(id: string, updates: Partial<Event>): Promise<Event> {
    const input: DynamoUpdateEventInput = {};

    if (updates.name !== undefined) input.name = updates.name;
    if (updates.status !== undefined)
      input.status = toDynamoEventStatus(updates.status);
    if (updates.startTime !== undefined) input.startTime = updates.startTime;
    if (updates.endTime !== undefined) input.endTime = updates.endTime;
    if (updates.timezone !== undefined) input.timezone = updates.timezone;
    if (updates.participantType !== undefined)
      input.participantType = toDynamoParticipantType(updates.participantType);
    if (updates.maxParticipants !== undefined)
      input.maxParticipants = updates.maxParticipants;
    if (updates.minTeamSize !== undefined)
      input.minTeamSize = updates.minTeamSize;
    if (updates.maxTeamSize !== undefined)
      input.maxTeamSize = updates.maxTeamSize;
    if (updates.registrationDeadline !== undefined)
      input.registrationDeadline = updates.registrationDeadline;
    if (updates.cloudProvider !== undefined)
      input.cloudProvider = toDynamoCloudProvider(updates.cloudProvider);
    if (updates.regions !== undefined) input.regions = updates.regions;
    if (updates.scoringType !== undefined)
      input.scoringType = toDynamoScoringType(updates.scoringType);
    if (updates.scoringIntervalMinutes !== undefined)
      input.scoringIntervalMinutes = updates.scoringIntervalMinutes;
    if (updates.leaderboardVisible !== undefined)
      input.leaderboardVisible = updates.leaderboardVisible;
    if (updates.freezeLeaderboardMinutes !== undefined)
      input.freezeLeaderboardMinutes = updates.freezeLeaderboardMinutes;

    const updated = await this.repo.update(id, input);
    return toEvent(updated);
  }

  async delete(id: string): Promise<void> {
    await this.repo.delete(id);
  }

  async findById(id: string): Promise<Event | null> {
    const event = await this.repo.findById(id);
    return event ? toEvent(event) : null;
  }

  async findByExternalId(externalId: string): Promise<Event | null> {
    const event = await this.repo.findByExternalId(externalId);
    return event ? toEvent(event) : null;
  }

  async findByTenant(
    tenantId: string,
    options?: EventFilterOptions
  ): Promise<Event[]> {
    const dynamoOptions: DynamoEventFilterOptions = {
      type: options?.type ? toDynamoProblemType(options.type) : undefined,
      status: options?.status
        ? Array.isArray(options.status)
          ? options.status.map(toDynamoEventStatus)
          : toDynamoEventStatus(options.status)
        : undefined,
      startAfter: options?.startAfter,
      startBefore: options?.startBefore,
      offset: options?.offset,
      limit: options?.limit,
    };

    const events = await this.repo.findByTenant(tenantId, dynamoOptions);
    return events.map(toEvent);
  }

  async findAll(options?: EventFilterOptions): Promise<Event[]> {
    const dynamoOptions: DynamoEventFilterOptions = {
      tenantId: options?.tenantId,
      type: options?.type ? toDynamoProblemType(options.type) : undefined,
      status: options?.status
        ? Array.isArray(options.status)
          ? options.status.map(toDynamoEventStatus)
          : toDynamoEventStatus(options.status)
        : undefined,
      startAfter: options?.startAfter,
      startBefore: options?.startBefore,
      offset: options?.offset,
      limit: options?.limit,
    };

    const { events } = await this.repo.list(dynamoOptions);
    return events.map(toEvent);
  }

  async count(options?: EventFilterOptions): Promise<number> {
    const dynamoOptions: DynamoEventFilterOptions = {
      tenantId: options?.tenantId,
      type: options?.type ? toDynamoProblemType(options.type) : undefined,
      status: options?.status
        ? Array.isArray(options.status)
          ? options.status.map(toDynamoEventStatus)
          : toDynamoEventStatus(options.status)
        : undefined,
      startAfter: options?.startAfter,
      startBefore: options?.startBefore,
    };

    return this.repo.count(dynamoOptions);
  }

  async updateStatus(id: string, status: EventStatus): Promise<void> {
    await this.repo.updateStatus(id, toDynamoEventStatus(status));
  }
}

/**
 * イベント詳細を取得（問題を含む）
 */
export async function getEventWithProblems(eventId: string) {
  return eventRepository.getEventWithProblems(eventId);
}

/**
 * イベントに問題を追加
 */
export async function addProblemToEvent(
  eventId: string,
  problemId: string,
  options?: {
    order?: number;
    unlockTime?: Date;
    pointMultiplier?: number;
  }
) {
  return eventRepository.addProblemToEvent(eventId, problemId, options);
}

/**
 * イベントの問題設定を更新
 */
export async function updateEventProblem(
  eventId: string,
  problemId: string,
  updates: {
    order?: number;
    unlockTime?: Date;
    pointMultiplier?: number;
  }
) {
  return eventRepository.updateEventProblem(eventId, problemId, updates);
}

/**
 * イベントから問題を削除
 */
export async function removeProblemFromEvent(
  eventId: string,
  problemId: string
) {
  return eventRepository.removeProblemFromEvent(eventId, problemId);
}

// Prisma エイリアスとして export（後方互換性）
export { DynamoEventRepository as PrismaEventRepository };
export default DynamoEventRepository;
