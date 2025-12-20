import type { Context } from 'hono';
import { Hono } from 'hono';
import { z } from 'zod';
import { SettingsService } from '../services/settings';
import { createLogger } from '../lib/logger';

const logger = createLogger('settings-api');
const settingsRoutes = new Hono();
const settingsService = new SettingsService();

/**
 * JSON 値として有効かを検証する型ガード
 * JSON.stringify で再帰的に検証し、function/undefined/symbol 等を検出
 */
const isJsonValue = (val: unknown): boolean => {
  try {
    JSON.stringify(val);
    return true;
  } catch {
    return false;
  }
};

const createSettingSchema = z.object({
  key: z.string().min(1).max(255),
  value: z.unknown().refine((val) => val !== undefined && isJsonValue(val), {
    message: '有効な JSON 値である必要があります',
  }),
  category: z.string().min(1).max(100),
});

const updateSettingSchema = z.object({
  value: z.unknown().refine((val) => val !== undefined && isJsonValue(val), {
    message: '有効な JSON 値である必要があります',
  }),
});

const listSettingsSchema = z.object({
  category: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).optional(),
  offset: z.coerce.number().min(0).optional(),
});

/**
 * 設定が見つからないエラーかを判定するヘルパー
 */
const isNotFoundError = (error: unknown): boolean => {
  return (
    error instanceof Error && error.message.startsWith('設定が見つかりません')
  );
};

/**
 * x-user-id ヘッダーを取得・検証するヘルパー
 */
const getUserIdFromHeader = (c: Context): string | null => {
  const userId = c.req.header('x-user-id');
  return userId && userId.trim() !== '' ? userId : null;
};

settingsRoutes.post('/settings', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: '無効な JSON 形式です' }, 400);
  }
  const parsed = createSettingSchema.safeParse(body);

  if (!parsed.success) {
    return c.json(
      { error: 'バリデーションエラー', details: parsed.error.issues },
      400
    );
  }

  const userId = getUserIdFromHeader(c);
  if (!userId) {
    return c.json({ error: '認証が必要です (x-user-id ヘッダー)' }, 401);
  }

  try {
    const setting = await settingsService.createSetting({
      ...parsed.data,
      updatedBy: userId,
    });
    return c.json(setting, 201);
  } catch (error) {
    logger.error({ error }, '設定作成エラー');
    throw error;
  }
});

settingsRoutes.get('/settings', async (c) => {
  const query = c.req.query();
  const parsed = listSettingsSchema.safeParse(query);

  if (!parsed.success) {
    return c.json(
      { error: 'バリデーションエラー', details: parsed.error.issues },
      400
    );
  }

  const result = await settingsService.listSettings(parsed.data);
  return c.json(result);
});

settingsRoutes.get('/settings/:key', async (c) => {
  const key = c.req.param('key');
  const setting = await settingsService.getSettingByKey(key);

  if (!setting) {
    return c.json({ error: '設定が見つかりません' }, 404);
  }

  return c.json(setting);
});

settingsRoutes.put('/settings/:key', async (c) => {
  const key = c.req.param('key');
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: '無効な JSON 形式です' }, 400);
  }
  const parsed = updateSettingSchema.safeParse(body);

  if (!parsed.success) {
    return c.json(
      { error: 'バリデーションエラー', details: parsed.error.issues },
      400
    );
  }

  const userId = getUserIdFromHeader(c);
  if (!userId) {
    return c.json({ error: '認証が必要です (x-user-id ヘッダー)' }, 401);
  }

  try {
    const setting = await settingsService.updateSetting(key, {
      ...parsed.data,
      updatedBy: userId,
    });
    return c.json(setting);
  } catch (error) {
    if (isNotFoundError(error)) {
      return c.json({ error: '設定が見つかりません' }, 404);
    }
    logger.error({ error }, '設定更新エラー');
    throw error;
  }
});

settingsRoutes.delete('/settings/:key', async (c) => {
  const key = c.req.param('key');

  const userId = getUserIdFromHeader(c);
  if (!userId) {
    return c.json({ error: '認証が必要です (x-user-id ヘッダー)' }, 401);
  }

  const ipAddress =
    c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip');
  const userAgent = c.req.header('user-agent');

  try {
    await settingsService.deleteSetting(key, {
      userId,
      ipAddress: ipAddress ?? undefined,
      userAgent: userAgent ?? undefined,
    });
    return c.body(null, 204);
  } catch (error) {
    logger.error({ error }, '設定削除エラー');
    throw error;
  }
});

export { settingsRoutes };
