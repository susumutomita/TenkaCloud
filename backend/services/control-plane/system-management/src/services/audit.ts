import type { AuditAction, AuditResourceType } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { createLogger } from '../lib/logger';

const logger = createLogger('audit-service');

export interface CreateAuditLogInput {
  tenantId?: string;
  userId?: string;
  action: AuditAction;
  resourceType: AuditResourceType;
  resourceId?: string;
  details?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

export interface ListAuditLogsInput {
  tenantId?: string;
  userId?: string;
  action?: AuditAction;
  resourceType?: AuditResourceType;
  startDate?: Date;
  endDate?: Date;
  limit?: number;
  offset?: number;
}

export interface AuditLogResult {
  id: string;
  tenantId: string | null;
  userId: string | null;
  action: AuditAction;
  resourceType: AuditResourceType;
  resourceId: string | null;
  details: unknown;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
}

export interface ListAuditLogsResult {
  logs: AuditLogResult[];
  total: number;
}

export class AuditService {
  async createLog(input: CreateAuditLogInput): Promise<AuditLogResult> {
    logger.info(
      { action: input.action, resourceType: input.resourceType },
      '監査ログを記録します'
    );

    const log = await prisma.auditLog.create({
      data: {
        tenantId: input.tenantId,
        userId: input.userId,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        details: input.details,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      },
    });

    logger.info({ logId: log.id }, '監査ログを記録しました');

    return log;
  }

  async listLogs(input: ListAuditLogsInput): Promise<ListAuditLogsResult> {
    const where = {
      ...(input.tenantId && { tenantId: input.tenantId }),
      ...(input.userId && { userId: input.userId }),
      ...(input.action && { action: input.action }),
      ...(input.resourceType && { resourceType: input.resourceType }),
      ...(input.startDate || input.endDate
        ? {
            createdAt: {
              ...(input.startDate && { gte: input.startDate }),
              ...(input.endDate && { lte: input.endDate }),
            },
          }
        : {}),
    };

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        take: input.limit ?? 50,
        skip: input.offset ?? 0,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.auditLog.count({ where }),
    ]);

    return { logs, total };
  }

  async getLogById(id: string): Promise<AuditLogResult | null> {
    return prisma.auditLog.findUnique({
      where: { id },
    });
  }
}
