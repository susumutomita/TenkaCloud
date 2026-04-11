import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { z } from 'zod';
import {
  SystemSettingRepository,
  AuditLogRepository,
} from '@tenkacloud/dynamodb';
import { createLogger } from '../lib/logger';
import {
  settingsSchema,
  settingsSchemaDefinition,
  DEFAULT_SETTINGS,
  errorResponse,
} from './shared';

const settingRepository = new SystemSettingRepository();
const auditLogRepository = new AuditLogRepository();
const logger = createLogger('tenant-api:settings');

const settingsRoutes = new Hono();

settingsRoutes.get(
  '/api/settings',
  describeRoute({
    tags: ['Settings'],
    summary: '設定取得',
    description: 'Control Plane の設定を取得します。',
    responses: {
      200: { description: '設定取得成功' },
      500: { description: '設定取得失敗' },
    },
  }),
  async (c) => {
    try {
      const [platform, security, notifications, appearance] = await Promise.all([
        settingRepository.get('platform'),
        settingRepository.get('security'),
        settingRepository.get('notifications'),
        settingRepository.get('appearance'),
      ]);

    const settings = {
      platform: platform?.value
        ? JSON.parse(platform.value as string)
        : DEFAULT_SETTINGS.platform,
      security: security?.value
        ? JSON.parse(security.value as string)
        : DEFAULT_SETTINGS.security,
      notifications: notifications?.value
        ? JSON.parse(notifications.value as string)
        : DEFAULT_SETTINGS.notifications,
      appearance: appearance?.value
        ? JSON.parse(appearance.value as string)
        : DEFAULT_SETTINGS.appearance,
    };

      return c.json(settings);
    } catch (error) {
      logger.error({ error }, 'Failed to fetch settings');
      return c.json(errorResponse('Failed to fetch settings', 500), 500);
    }
  }
);

settingsRoutes.put(
  '/api/settings',
  describeRoute({
    tags: ['Settings'],
    summary: '設定更新',
    description: 'Control Plane の設定を更新します。',
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: settingsSchemaDefinition as any,
        },
      },
    },
    responses: {
      200: { description: '設定更新成功' },
      400: { description: 'バリデーションエラー' },
      500: { description: '設定更新失敗' },
    },
  }),
  async (c) => {
    try {
      const body = await c.req.json();
      const validated = settingsSchema.parse(body);

    // Save each category as a separate key
    await Promise.all([
      settingRepository.set({
        key: 'platform',
        value: JSON.stringify(validated.platform),
        category: 'system',
        updatedBy: 'system',
      }),
      settingRepository.set({
        key: 'security',
        value: JSON.stringify(validated.security),
        category: 'system',
        updatedBy: 'system',
      }),
      settingRepository.set({
        key: 'notifications',
        value: JSON.stringify(validated.notifications),
        category: 'system',
        updatedBy: 'system',
      }),
      settingRepository.set({
        key: 'appearance',
        value: JSON.stringify(validated.appearance),
        category: 'system',
        updatedBy: 'system',
      }),
    ]);

      logger.info('Settings updated successfully');
      return c.json({ success: true, message: 'Settings saved successfully' });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return c.json(errorResponse('Validation error', 400, error.errors), 400);
      }

      logger.error({ error }, 'Failed to save settings');
      return c.json(errorResponse('Failed to save settings', 500), 500);
    }
  }
);

settingsRoutes.get(
  '/api/activities',
  describeRoute({
    tags: ['Audit'],
    summary: '監査アクティビティ一覧取得',
    description: 'Control Plane の最近の監査ログを取得します。',
    parameters: [
      {
        name: 'limit',
        in: 'query',
        required: false,
        schema: { type: 'integer', default: 10, minimum: 1, maximum: 50 },
        description: '取得件数',
      },
    ],
    responses: {
      200: { description: 'アクティビティ取得成功' },
      500: { description: 'アクティビティ取得失敗' },
    },
  }),
  async (c) => {
    try {
      const limitParam = parseInt(c.req.query('limit') || '10', 10);
      const limit = Math.min(
        50,
        Math.max(1, isNaN(limitParam) ? 10 : limitParam)
      );

    // Fetch system-wide activities (tenantId is empty for system events)
    const result = await auditLogRepository.listByTenant('', { limit });

    // Transform audit logs to activity format
    const activities = result.logs.map((log) => ({
      id: log.id,
      action: log.action,
      resourceType: log.resourceType,
      resourceId: log.resourceId,
      details: log.details,
      timestamp: log.createdAt.toISOString(),
    }));

      return c.json({
        data: activities,
        pagination: {
          limit,
          hasNextPage: !!result.lastKey,
        },
      });
    } catch (error) {
      logger.error({ error }, 'Failed to fetch activities');
      return c.json(errorResponse('Failed to fetch activities', 500), 500);
    }
  }
);

export { settingsRoutes };
