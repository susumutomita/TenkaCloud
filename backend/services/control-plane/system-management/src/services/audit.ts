import type {
  AuditAction,
  AuditResourceType,
  AuditLog,
} from '@tenkacloud/dynamodb';
import { auditLogRepository } from '../lib/dynamodb';
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

export interface ListAuditLogsResult {
  logs: AuditLog[];
  total: number;
}

export class AuditService {
  async createLog(input: CreateAuditLogInput): Promise<AuditLog> {
    logger.info(
      { action: input.action, resourceType: input.resourceType },
      '監査ログを記録します'
    );

    const log = await auditLogRepository.create({
      tenantId: input.tenantId,
      userId: input.userId,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      details: input.details,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    });

    logger.info({ logId: log.id }, '監査ログを記録しました');

    return log;
  }

  async listLogs(input: ListAuditLogsInput): Promise<ListAuditLogsResult> {
    // DynamoDB はテナント単位またはユーザー単位でクエリ
    // ユーザー指定がある場合はユーザーベースでクエリ
    if (input.userId && !input.tenantId) {
      const result = await auditLogRepository.listByUser(input.userId, {
        limit: input.limit ?? 50,
      });

      // フィルタリング（action, resourceType, 日付範囲）
      let logs = result.logs;

      if (input.action) {
        logs = logs.filter((log) => log.action === input.action);
      }
      if (input.resourceType) {
        logs = logs.filter((log) => log.resourceType === input.resourceType);
      }
      if (input.startDate) {
        logs = logs.filter((log) => log.createdAt >= input.startDate!);
      }
      if (input.endDate) {
        logs = logs.filter((log) => log.createdAt <= input.endDate!);
      }

      return { logs, total: logs.length };
    }

    // テナント指定（またはシステムログ）
    const tenantId = input.tenantId ?? '';
    const result = await auditLogRepository.listByTenant(tenantId, {
      action: input.action,
      resourceType: input.resourceType,
      limit: input.limit ?? 50,
    });

    // 日付フィルタはクライアント側で
    let logs = result.logs;
    if (input.startDate) {
      logs = logs.filter((log) => log.createdAt >= input.startDate!);
    }
    if (input.endDate) {
      logs = logs.filter((log) => log.createdAt <= input.endDate!);
    }

    return { logs, total: logs.length };
  }

  async getLogById(id: string): Promise<AuditLog | null> {
    // DynamoDB の Single Table Design では ID のみでの検索は非効率
    // 実際の用途に応じて GSI を追加するか、listLogs を使用することを推奨
    // 暫定的にシステムログを検索
    const result = await auditLogRepository.listByTenant('', { limit: 100 });
    return result.logs.find((log) => log.id === id) ?? null;
  }
}
