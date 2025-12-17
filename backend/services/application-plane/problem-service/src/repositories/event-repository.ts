/**
 * Prisma Event Repository
 *
 * PostgreSQL を使用したイベントリポジトリ実装
 */

import type {
  Event as PrismaEvent,
  EventStatus as PrismaEventStatus,
  ProblemType as PrismaProblemType,
  ParticipantType as PrismaParticipantType,
  ScoringType as PrismaScoringType,
  CloudProvider as PrismaCloudProvider,
} from '@prisma/client';
import { prisma } from './prisma-client';
import type {
  IEventRepository,
  EventFilterOptions,
} from '../events/repository';
import type { Event, EventStatus, EventType } from '../types';

/**
 * Prisma Event を内部型に変換
 */
function toEvent(prismaEvent: PrismaEvent): Event {
  return {
    id: prismaEvent.id,
    externalId: prismaEvent.externalId,
    tenantId: prismaEvent.tenantId,
    name: prismaEvent.name,
    type: prismaEvent.type.toLowerCase() as EventType,
    status: prismaEvent.status.toLowerCase() as EventStatus,
    startTime: prismaEvent.startTime,
    endTime: prismaEvent.endTime,
    timezone: prismaEvent.timezone,
    participantType: prismaEvent.participantType.toLowerCase() as
      | 'individual'
      | 'team',
    maxParticipants: prismaEvent.maxParticipants,
    minTeamSize: prismaEvent.minTeamSize ?? undefined,
    maxTeamSize: prismaEvent.maxTeamSize ?? undefined,
    registrationDeadline: prismaEvent.registrationDeadline ?? undefined,
    cloudProvider: prismaEvent.cloudProvider.toLowerCase() as
      | 'aws'
      | 'gcp'
      | 'azure'
      | 'local',
    regions: prismaEvent.regions,
    scoringType: prismaEvent.scoringType.toLowerCase() as 'realtime' | 'batch',
    scoringIntervalMinutes: prismaEvent.scoringIntervalMinutes,
    leaderboardVisible: prismaEvent.leaderboardVisible,
    freezeLeaderboardMinutes: prismaEvent.freezeLeaderboardMinutes ?? undefined,
    createdAt: prismaEvent.createdAt,
    updatedAt: prismaEvent.updatedAt,
    createdBy: prismaEvent.createdBy ?? undefined,
  };
}

/**
 * 内部型を Prisma 型に変換
 */
function toPrismaStatus(status: EventStatus): PrismaEventStatus {
  const map: Record<EventStatus, PrismaEventStatus> = {
    draft: 'DRAFT',
    scheduled: 'SCHEDULED',
    active: 'ACTIVE',
    paused: 'PAUSED',
    completed: 'COMPLETED',
    cancelled: 'CANCELLED',
  };
  return map[status];
}

function toPrismaType(type: EventType): PrismaProblemType {
  const map: Record<EventType, PrismaProblemType> = {
    gameday: 'GAMEDAY',
    jam: 'JAM',
  };
  return map[type];
}

function toPrismaParticipantType(
  type: 'individual' | 'team'
): PrismaParticipantType {
  const map: Record<'individual' | 'team', PrismaParticipantType> = {
    individual: 'INDIVIDUAL',
    team: 'TEAM',
  };
  return map[type];
}

function toPrismaScoringType(type: 'realtime' | 'batch'): PrismaScoringType {
  const map: Record<'realtime' | 'batch', PrismaScoringType> = {
    realtime: 'REALTIME',
    batch: 'BATCH',
  };
  return map[type];
}

function toPrismaCloudProvider(
  provider: 'aws' | 'gcp' | 'azure' | 'local'
): PrismaCloudProvider {
  const map: Record<'aws' | 'gcp' | 'azure' | 'local', PrismaCloudProvider> = {
    aws: 'AWS',
    gcp: 'GCP',
    azure: 'AZURE',
    local: 'LOCAL',
  };
  return map[provider];
}

/**
 * Prisma Event Repository 実装
 */
export class PrismaEventRepository implements IEventRepository {
  async create(
    eventData: Omit<Event, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<Event> {
    const created = await prisma.event.create({
      data: {
        externalId: eventData.externalId || `evt-${Date.now()}`,
        tenantId: eventData.tenantId,
        name: eventData.name,
        type: toPrismaType(eventData.type),
        status: toPrismaStatus(eventData.status || 'draft'),
        startTime: eventData.startTime,
        endTime: eventData.endTime,
        timezone: eventData.timezone || 'Asia/Tokyo',
        participantType: toPrismaParticipantType(eventData.participantType),
        maxParticipants: eventData.maxParticipants,
        minTeamSize: eventData.minTeamSize,
        maxTeamSize: eventData.maxTeamSize,
        registrationDeadline: eventData.registrationDeadline,
        cloudProvider: toPrismaCloudProvider(eventData.cloudProvider),
        regions: eventData.regions,
        scoringType: toPrismaScoringType(eventData.scoringType),
        scoringIntervalMinutes: eventData.scoringIntervalMinutes,
        leaderboardVisible: eventData.leaderboardVisible ?? true,
        freezeLeaderboardMinutes: eventData.freezeLeaderboardMinutes,
        createdBy: eventData.createdBy,
      },
    });

    return toEvent(created);
  }

  async update(id: string, updates: Partial<Event>): Promise<Event> {
    const data: Record<string, unknown> = {};

    if (updates.name !== undefined) data.name = updates.name;
    if (updates.status !== undefined)
      data.status = toPrismaStatus(updates.status);
    if (updates.startTime !== undefined) data.startTime = updates.startTime;
    if (updates.endTime !== undefined) data.endTime = updates.endTime;
    if (updates.timezone !== undefined) data.timezone = updates.timezone;
    if (updates.participantType !== undefined)
      data.participantType = toPrismaParticipantType(updates.participantType);
    if (updates.maxParticipants !== undefined)
      data.maxParticipants = updates.maxParticipants;
    if (updates.minTeamSize !== undefined)
      data.minTeamSize = updates.minTeamSize;
    if (updates.maxTeamSize !== undefined)
      data.maxTeamSize = updates.maxTeamSize;
    if (updates.registrationDeadline !== undefined)
      data.registrationDeadline = updates.registrationDeadline;
    if (updates.cloudProvider !== undefined)
      data.cloudProvider = toPrismaCloudProvider(updates.cloudProvider);
    if (updates.regions !== undefined) data.regions = updates.regions;
    if (updates.scoringType !== undefined)
      data.scoringType = toPrismaScoringType(updates.scoringType);
    if (updates.scoringIntervalMinutes !== undefined)
      data.scoringIntervalMinutes = updates.scoringIntervalMinutes;
    if (updates.leaderboardVisible !== undefined)
      data.leaderboardVisible = updates.leaderboardVisible;
    if (updates.freezeLeaderboardMinutes !== undefined)
      data.freezeLeaderboardMinutes = updates.freezeLeaderboardMinutes;

    const updated = await prisma.event.update({
      where: { id },
      data,
    });

    return toEvent(updated);
  }

  async delete(id: string): Promise<void> {
    await prisma.event.delete({
      where: { id },
    });
  }

  async findById(id: string): Promise<Event | null> {
    const event = await prisma.event.findUnique({
      where: { id },
    });

    return event ? toEvent(event) : null;
  }

  async findByExternalId(externalId: string): Promise<Event | null> {
    const event = await prisma.event.findUnique({
      where: { externalId },
    });

    return event ? toEvent(event) : null;
  }

  async findByTenant(
    tenantId: string,
    options?: EventFilterOptions
  ): Promise<Event[]> {
    const where: Record<string, unknown> = { tenantId };

    if (options?.type) {
      where.type = toPrismaType(options.type);
    }
    if (options?.status) {
      const statuses = Array.isArray(options.status)
        ? options.status
        : [options.status];
      where.status = { in: statuses.map(toPrismaStatus) };
    }
    if (options?.startAfter) {
      where.startTime = {
        ...((where.startTime as object) || {}),
        gte: options.startAfter,
      };
    }
    if (options?.startBefore) {
      where.startTime = {
        ...((where.startTime as object) || {}),
        lte: options.startBefore,
      };
    }

    const events = await prisma.event.findMany({
      where,
      orderBy: { startTime: 'desc' },
      skip: options?.offset,
      take: options?.limit,
    });

    return events.map(toEvent);
  }

  async findAll(options?: EventFilterOptions): Promise<Event[]> {
    const where: Record<string, unknown> = {};

    if (options?.tenantId) {
      where.tenantId = options.tenantId;
    }
    if (options?.type) {
      where.type = toPrismaType(options.type);
    }
    if (options?.status) {
      const statuses = Array.isArray(options.status)
        ? options.status
        : [options.status];
      where.status = { in: statuses.map(toPrismaStatus) };
    }
    if (options?.startAfter) {
      where.startTime = {
        ...((where.startTime as object) || {}),
        gte: options.startAfter,
      };
    }
    if (options?.startBefore) {
      where.startTime = {
        ...((where.startTime as object) || {}),
        lte: options.startBefore,
      };
    }

    const events = await prisma.event.findMany({
      where,
      orderBy: { startTime: 'desc' },
      skip: options?.offset,
      take: options?.limit,
    });

    return events.map(toEvent);
  }

  async count(options?: EventFilterOptions): Promise<number> {
    const where: Record<string, unknown> = {};

    if (options?.tenantId) {
      where.tenantId = options.tenantId;
    }
    if (options?.type) {
      where.type = toPrismaType(options.type);
    }
    if (options?.status) {
      const statuses = Array.isArray(options.status)
        ? options.status
        : [options.status];
      where.status = { in: statuses.map(toPrismaStatus) };
    }
    if (options?.startAfter) {
      where.startTime = {
        ...((where.startTime as object) || {}),
        gte: options.startAfter,
      };
    }
    if (options?.startBefore) {
      where.startTime = {
        ...((where.startTime as object) || {}),
        lte: options.startBefore,
      };
    }

    return prisma.event.count({ where });
  }

  async updateStatus(id: string, status: EventStatus): Promise<void> {
    await prisma.event.update({
      where: { id },
      data: { status: toPrismaStatus(status) },
    });
  }
}

/**
 * イベント詳細を取得（問題を含む）
 */
export async function getEventWithProblems(eventId: string) {
  return prisma.event.findUnique({
    where: { id: eventId },
    include: {
      problems: {
        include: {
          problem: {
            include: {
              criteria: true,
            },
          },
        },
        orderBy: { order: 'asc' },
      },
    },
  });
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
  const existing = await prisma.eventProblem.findUnique({
    where: {
      eventId_problemId: { eventId, problemId },
    },
  });

  if (existing) {
    return prisma.eventProblem.update({
      where: {
        eventId_problemId: { eventId, problemId },
      },
      data: {
        order: options?.order,
        unlockTime: options?.unlockTime,
        pointMultiplier: options?.pointMultiplier,
      },
    });
  }

  const count = await prisma.eventProblem.count({ where: { eventId } });

  return prisma.eventProblem.create({
    data: {
      eventId,
      problemId,
      order: options?.order ?? count + 1,
      unlockTime: options?.unlockTime,
      pointMultiplier: options?.pointMultiplier ?? 1,
    },
  });
}

/**
 * イベントから問題を削除
 */
export async function removeProblemFromEvent(
  eventId: string,
  problemId: string
) {
  return prisma.eventProblem.delete({
    where: {
      eventId_problemId: { eventId, problemId },
    },
  });
}

export default PrismaEventRepository;
