import { Hono } from 'hono';
import {
  startGameSchema,
  toggleScoreWeightSchema,
  toggleBlackoutSchema,
  faultInjectionSchema,
} from '../schemas';

export const adminRoutes = new Hono();

// ゲーム開始
adminRoutes.post('/game/start', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (body === null) {
    return c.json({ error: 'JSON の解析に失敗しました' }, 400);
  }
  const parsed = startGameSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: '無効なリクエスト', details: parsed.error.issues },
      400
    );
  }
  // TODO: ゲーム開始ロジック実装
  return c.json({ error: '未実装です' }, 501);
});

// ゲーム停止
adminRoutes.post('/game/stop', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (body === null) {
    return c.json({ error: 'JSON の解析に失敗しました' }, 400);
  }
  const parsed = toggleScoreWeightSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: '無効なリクエスト', details: parsed.error.issues },
      400
    );
  }
  // TODO: ゲーム停止ロジック実装
  return c.json({ error: '未実装です' }, 501);
});

// ゲーム状態取得
adminRoutes.get('/game/status', async (c) => {
  const eventId = c.req.query('eventId');
  if (!eventId) {
    return c.json({ error: 'eventId は必須です' }, 400);
  }
  // TODO: ゲーム状態取得ロジック実装
  return c.json(
    {
      eventId,
      isRunning: false,
      startedAt: null,
      scoreWeight: 'normal',
      blackout: false,
      durationMinutes: 240,
    },
    200
  );
});

// スコア重み切替
adminRoutes.post('/score-weight/toggle', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (body === null) {
    return c.json({ error: 'JSON の解析に失敗しました' }, 400);
  }
  const parsed = toggleScoreWeightSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: '無効なリクエスト', details: parsed.error.issues },
      400
    );
  }
  // TODO: スコア重み切替ロジック実装
  return c.json({ error: '未実装です' }, 501);
});

// ブラックアウト切替
adminRoutes.post('/blackout/toggle', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (body === null) {
    return c.json({ error: 'JSON の解析に失敗しました' }, 400);
  }
  const parsed = toggleBlackoutSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: '無効なリクエスト', details: parsed.error.issues },
      400
    );
  }
  // TODO: ブラックアウト切替ロジック実装
  return c.json({ error: '未実装です' }, 501);
});

// 障害注入
adminRoutes.post('/fault-injection/execute', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (body === null) {
    return c.json({ error: 'JSON の解析に失敗しました' }, 400);
  }
  const parsed = faultInjectionSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: '無効なリクエスト', details: parsed.error.issues },
      400
    );
  }
  // TODO: 障害注入ロジック実装
  return c.json({ error: '未実装です' }, 501);
});

// 全チーム状態一覧
adminRoutes.get('/teams', async (c) => {
  const eventId = c.req.query('eventId');
  if (!eventId) {
    return c.json({ error: 'eventId は必須です' }, 400);
  }
  // TODO: チーム一覧取得ロジック実装
  return c.json({ teams: [] }, 200);
});

// 全攻撃履歴
adminRoutes.get('/attack-logs', async (c) => {
  const eventId = c.req.query('eventId');
  if (!eventId) {
    return c.json({ error: 'eventId は必須です' }, 400);
  }
  // TODO: 攻撃履歴取得ロジック実装
  return c.json({ logs: [] }, 200);
});
