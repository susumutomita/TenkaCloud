import { Hono } from 'hono';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { AuditService } from '../services/audit';
import { createLogger } from '../lib/logger';

const logger = createLogger('audit-api');
const auditRoutes = new Hono();
const auditService = new AuditService();

/**
 * JSON 値として有効かを検証する型ガード
 */
const isJsonValue = (val: unknown): val is Prisma.InputJsonValue =>
  val === null ||
  typeof val === 'string' ||
  typeof val === 'number' ||
  typeof val === 'boolean' ||
  (typeof val === 'object' && val !== null);

const createAuditLogSchema = z.object({
  tenantId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  action: z.enum(['CREATE', 'UPDATE', 'DELETE', 'LOGIN', 'LOGOUT', 'ACCESS']),
  resourceType: z.enum([
    'USER',
    'TENANT',
    'BATTLE',
    'PROBLEM',
    'SETTING',
    'SYSTEM',
  ]),
  resourceId: z.string().optional(),
  details: z
    .unknown()
    .optional()
    .refine(
      (val): val is Prisma.InputJsonValue | undefined =>
        val === undefined || isJsonValue(val),
      { message: '有効な JSON 値である必要があります' }
    ),
});

const listAuditLogsSchema = z.object({
  tenantId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  action: z
    .enum(['CREATE', 'UPDATE', 'DELETE', 'LOGIN', 'LOGOUT', 'ACCESS'])
    .optional(),
  resourceType: z
    .enum(['USER', 'TENANT', 'BATTLE', 'PROBLEM', 'SETTING', 'SYSTEM'])
    .optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  limit: z.coerce.number().min(1).max(100).optional(),
  offset: z.coerce.number().min(0).optional(),
});

auditRoutes.post('/audit/logs', async (c) => {
  const body = await c.req.json();
  const parsed = createAuditLogSchema.safeParse(body);

  if (!parsed.success) {
    return c.json(
      { error: 'バリデーションエラー', details: parsed.error.issues },
      400
    );
  }

  const ipAddress =
    c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip');
  const userAgent = c.req.header('user-agent');

  const log = await auditService.createLog({
    ...parsed.data,
    ipAddress,
    userAgent,
  });

  return c.json(log, 201);
});

auditRoutes.get('/audit/logs', async (c) => {
  const query = c.req.query();
  const parsed = listAuditLogsSchema.safeParse(query);

  if (!parsed.success) {
    return c.json(
      { error: 'バリデーションエラー', details: parsed.error.issues },
      400
    );
  }

  const result = await auditService.listLogs({
    ...parsed.data,
    startDate: parsed.data.startDate
      ? new Date(parsed.data.startDate)
      : undefined,
    endDate: parsed.data.endDate ? new Date(parsed.data.endDate) : undefined,
  });

  return c.json(result);
});

auditRoutes.get('/audit/logs/:id', async (c) => {
  const id = c.req.param('id');
  const log = await auditService.getLogById(id);

  if (!log) {
    return c.json({ error: '監査ログが見つかりません' }, 404);
  }

  return c.json(log);
});

export { auditRoutes };
