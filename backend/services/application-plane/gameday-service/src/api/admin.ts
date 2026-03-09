import { Hono } from 'hono';
import { StatusCodes } from 'http-status-codes';
import {
  eventIdSchema,
  startGameSchema,
  faultInjectionSchema,
  seedAttacksSchema,
  registerTeamSchema,
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
  seedAttackCatalog,
  GameNotFoundError,
  ConcurrentModificationError,
} from '../services/game-controller';
import {
  registerTeam,
  TeamAlreadyExistsError,
} from '../services/dashboard-service';

export const adminRoutes = new Hono();

// ゲーム開始
adminRoutes.post('/game/start', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (body === null) {
    return c.json(
      { error: 'JSON の解析に失敗しました' },
      StatusCodes.BAD_REQUEST
    );
  }
  const parsed = startGameSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: '無効なリクエスト', details: parsed.error.issues },
      StatusCodes.BAD_REQUEST
    );
  }
  const tenantId = c.get('auth').tenantId;
  const result = await startGame(
    parsed.data.eventId,
    tenantId,
    parsed.data.durationMinutes
  );
  return c.json(result, StatusCodes.CREATED);
});

// ゲーム停止
adminRoutes.post('/game/stop', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (body === null) {
    return c.json(
      { error: 'JSON の解析に失敗しました' },
      StatusCodes.BAD_REQUEST
    );
  }
  const parsed = eventIdSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: '無効なリクエスト', details: parsed.error.issues },
      StatusCodes.BAD_REQUEST
    );
  }
  try {
    const result = await stopGame(parsed.data.eventId);
    return c.json(result, StatusCodes.OK);
  } catch (error) {
    if (error instanceof GameNotFoundError) {
      return c.json({ error: error.message }, StatusCodes.NOT_FOUND);
    }
    throw error;
  }
});

// ゲーム状態取得
adminRoutes.get('/game/status', async (c) => {
  const eventId = c.req.query('eventId');
  if (!eventId) {
    return c.json({ error: 'eventId は必須です' }, StatusCodes.BAD_REQUEST);
  }
  const result = await getGameStatus(eventId);
  if (!result) {
    return c.json({ error: 'ゲームが見つかりません' }, StatusCodes.NOT_FOUND);
  }
  return c.json(result, StatusCodes.OK);
});

// スコア重み切替
adminRoutes.post('/score-weight/toggle', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (body === null) {
    return c.json(
      { error: 'JSON の解析に失敗しました' },
      StatusCodes.BAD_REQUEST
    );
  }
  const parsed = eventIdSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: '無効なリクエスト', details: parsed.error.issues },
      StatusCodes.BAD_REQUEST
    );
  }
  try {
    const result = await toggleScoreWeight(parsed.data.eventId);
    return c.json(result, StatusCodes.OK);
  } catch (error) {
    if (error instanceof GameNotFoundError) {
      return c.json({ error: error.message }, StatusCodes.NOT_FOUND);
    }
    if (error instanceof ConcurrentModificationError) {
      return c.json({ error: error.message }, StatusCodes.CONFLICT);
    }
    throw error;
  }
});

// ブラックアウト切替
adminRoutes.post('/blackout/toggle', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (body === null) {
    return c.json(
      { error: 'JSON の解析に失敗しました' },
      StatusCodes.BAD_REQUEST
    );
  }
  const parsed = eventIdSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: '無効なリクエスト', details: parsed.error.issues },
      StatusCodes.BAD_REQUEST
    );
  }
  try {
    const result = await toggleBlackout(parsed.data.eventId);
    return c.json(result, StatusCodes.OK);
  } catch (error) {
    if (error instanceof GameNotFoundError) {
      return c.json({ error: error.message }, StatusCodes.NOT_FOUND);
    }
    if (error instanceof ConcurrentModificationError) {
      return c.json({ error: error.message }, StatusCodes.CONFLICT);
    }
    throw error;
  }
});

// 障害注入
adminRoutes.post('/fault-injection/execute', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (body === null) {
    return c.json(
      { error: 'JSON の解析に失敗しました' },
      StatusCodes.BAD_REQUEST
    );
  }
  const parsed = faultInjectionSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: '無効なリクエスト', details: parsed.error.issues },
      StatusCodes.BAD_REQUEST
    );
  }
  const result = await executeFaultInjection(
    parsed.data.eventId,
    parsed.data.teamId,
    parsed.data.attackSlug
  );
  return c.json(result, StatusCodes.CREATED);
});

// 全チーム状態一覧
adminRoutes.get('/teams', async (c) => {
  const eventId = c.req.query('eventId');
  if (!eventId) {
    return c.json({ error: 'eventId は必須です' }, StatusCodes.BAD_REQUEST);
  }
  const teams = await listTeams(eventId);
  return c.json({ teams }, StatusCodes.OK);
});

// 全攻撃履歴
adminRoutes.get('/attack-logs', async (c) => {
  const eventId = c.req.query('eventId');
  if (!eventId) {
    return c.json({ error: 'eventId は必須です' }, StatusCodes.BAD_REQUEST);
  }
  const logs = await listAttackLogs(eventId);
  return c.json({ logs }, StatusCodes.OK);
});

// チーム登録
adminRoutes.post('/teams/register', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (body === null) {
    return c.json(
      { error: 'JSON の解析に失敗しました' },
      StatusCodes.BAD_REQUEST
    );
  }
  const parsed = registerTeamSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: '無効なリクエスト', details: parsed.error.issues },
      StatusCodes.BAD_REQUEST
    );
  }
  try {
    const result = await registerTeam(parsed.data);
    return c.json(result, StatusCodes.CREATED);
  } catch (error) {
    if (error instanceof TeamAlreadyExistsError) {
      return c.json({ error: error.message }, StatusCodes.CONFLICT);
    }
    throw error;
  }
});

// 攻撃カタログシード
adminRoutes.post('/attacks/seed', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (body === null) {
    return c.json(
      { error: 'JSON の解析に失敗しました' },
      StatusCodes.BAD_REQUEST
    );
  }
  const parsed = seedAttacksSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: '無効なリクエスト', details: parsed.error.issues },
      StatusCodes.BAD_REQUEST
    );
  }
  const count = await seedAttackCatalog(parsed.data.eventId);
  return c.json({ seeded: count }, StatusCodes.CREATED);
});
