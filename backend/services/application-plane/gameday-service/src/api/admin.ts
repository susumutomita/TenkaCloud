import { Hono } from 'hono';
import {
  startGameSchema,
  toggleScoreWeightSchema,
  toggleBlackoutSchema,
  faultInjectionSchema,
} from '../schemas';
import {
  startGame,
  stopGame,
  getGameStatus,
  toggleScoreWeight,
  toggleBlackout,
  executeFaultInjection,
  listTeams,
  listAttackLogs,
} from '../services/game-controller';

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
  const auth = c.get('auth' as never) as { tenantId: string } | undefined;
  const tenantId = auth?.tenantId ?? '';
  const result = await startGame(
    parsed.data.eventId,
    tenantId,
    parsed.data.durationMinutes
  );
  return c.json(result, 201);
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
  const result = await stopGame(parsed.data.eventId);
  return c.json(result, 200);
});

// ゲーム状態取得
adminRoutes.get('/game/status', async (c) => {
  const eventId = c.req.query('eventId');
  if (!eventId) {
    return c.json({ error: 'eventId は必須です' }, 400);
  }
  const result = await getGameStatus(eventId);
  if (!result) {
    return c.json({ error: 'ゲームが見つかりません' }, 404);
  }
  return c.json(result, 200);
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
  const result = await toggleScoreWeight(parsed.data.eventId);
  return c.json(result, 200);
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
  const result = await toggleBlackout(parsed.data.eventId);
  return c.json(result, 200);
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
  const result = await executeFaultInjection(
    parsed.data.eventId,
    parsed.data.teamId,
    parsed.data.attackSlug
  );
  return c.json(result, 201);
});

// 全チーム状態一覧
adminRoutes.get('/teams', async (c) => {
  const eventId = c.req.query('eventId');
  if (!eventId) {
    return c.json({ error: 'eventId は必須です' }, 400);
  }
  const teams = await listTeams(eventId);
  return c.json({ teams }, 200);
});

// 全攻撃履歴
adminRoutes.get('/attack-logs', async (c) => {
  const eventId = c.req.query('eventId');
  if (!eventId) {
    return c.json({ error: 'eventId は必須です' }, 400);
  }
  const logs = await listAttackLogs(eventId);
  return c.json({ logs }, 200);
});
