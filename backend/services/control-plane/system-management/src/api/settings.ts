import { Hono } from 'hono';
import { z } from 'zod';
import { SettingsService } from '../services/settings';
import { createLogger } from '../lib/logger';

const logger = createLogger('settings-api');
const settingsRoutes = new Hono();
const settingsService = new SettingsService();

const createSettingSchema = z.object({
  key: z.string().min(1).max(255),
  value: z.unknown(),
  category: z.string().min(1).max(100),
});

const updateSettingSchema = z.object({
  value: z.unknown(),
});

const listSettingsSchema = z.object({
  category: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).optional(),
  offset: z.coerce.number().min(0).optional(),
});

settingsRoutes.post('/settings', async (c) => {
  const body = await c.req.json();
  const parsed = createSettingSchema.safeParse(body);

  if (!parsed.success) {
    return c.json(
      { error: 'バリデーションエラー', details: parsed.error.issues },
      400
    );
  }

  const userId = c.req.header('x-user-id');

  try {
    const setting = await settingsService.createSetting({
      ...parsed.data,
      updatedBy: userId,
    });
    return c.json(setting, 201);
  } catch (error) {
    if (error instanceof Error && error.message.includes('Unique constraint')) {
      return c.json({ error: '設定キーが既に存在します' }, 409);
    }
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
  const body = await c.req.json();
  const parsed = updateSettingSchema.safeParse(body);

  if (!parsed.success) {
    return c.json(
      { error: 'バリデーションエラー', details: parsed.error.issues },
      400
    );
  }

  const userId = c.req.header('x-user-id');

  try {
    const setting = await settingsService.updateSetting(key, {
      ...parsed.data,
      updatedBy: userId,
    });
    return c.json(setting);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes('Record to update not found')
    ) {
      return c.json({ error: '設定が見つかりません' }, 404);
    }
    throw error;
  }
});

settingsRoutes.delete('/settings/:key', async (c) => {
  const key = c.req.param('key');

  try {
    await settingsService.deleteSetting(key);
    return c.body(null, 204);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes('Record to delete does not exist')
    ) {
      return c.json({ error: '設定が見つかりません' }, 404);
    }
    throw error;
  }
});

export { settingsRoutes };
