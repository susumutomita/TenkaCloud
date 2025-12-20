import { Hono } from 'hono';
import { z } from 'zod';
import { BattleMode, BattleStatus } from '@tenkacloud/dynamodb';
import {
  createBattle,
  getBattle,
  listBattles,
  updateBattle,
  deleteBattle,
  startBattle,
  endBattle,
  joinBattle,
  leaveBattle,
  updateScore,
} from '../services/battle';

export const battlesRoutes = new Hono();

const createBattleSchema = z.object({
  title: z.string().min(1).max(100),
  description: z.string().max(1000).optional(),
  mode: z.enum([BattleMode.INDIVIDUAL, BattleMode.TEAM]),
  maxParticipants: z.number().int().min(2).max(100).default(10),
  timeLimit: z.number().int().min(60).max(86400).default(3600),
});

const updateBattleSchema = z.object({
  title: z.string().min(1).max(100).optional(),
  description: z.string().max(1000).optional(),
  maxParticipants: z.number().int().min(2).max(100).optional(),
  timeLimit: z.number().int().min(60).max(86400).optional(),
});

const listBattlesSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z
    .enum([
      BattleStatus.WAITING,
      BattleStatus.IN_PROGRESS,
      BattleStatus.FINISHED,
      BattleStatus.CANCELLED,
    ])
    .optional(),
});

const updateScoreSchema = z.object({
  score: z.number().int().min(0),
});

// バトル一覧取得
battlesRoutes.get('/battles', async (c) => {
  const auth = c.get('auth');
  const query = c.req.query();

  const parsed = listBattlesSchema.safeParse(query);
  if (!parsed.success) {
    return c.json(
      { error: 'パラメータが不正です', details: parsed.error.issues },
      400
    );
  }

  const result = await listBattles(auth.tenantId, parsed.data);
  return c.json(result);
});

// バトル作成
battlesRoutes.post('/battles', async (c) => {
  const auth = c.get('auth');

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'リクエストボディが不正です' }, 400);
  }

  const parsed = createBattleSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: 'バリデーションエラー', details: parsed.error.issues },
      400
    );
  }

  const battle = await createBattle({
    ...parsed.data,
    tenantId: auth.tenantId,
  });

  return c.json(battle, 201);
});

// バトル詳細取得
battlesRoutes.get('/battles/:id', async (c) => {
  const auth = c.get('auth');
  const battleId = c.req.param('id');

  const battle = await getBattle(battleId, auth.tenantId);
  if (!battle) {
    return c.json({ error: 'バトルが見つかりません' }, 404);
  }

  return c.json(battle);
});

// バトル更新
battlesRoutes.patch('/battles/:id', async (c) => {
  const auth = c.get('auth');
  const battleId = c.req.param('id');

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'リクエストボディが不正です' }, 400);
  }

  const parsed = updateBattleSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: 'バリデーションエラー', details: parsed.error.issues },
      400
    );
  }

  try {
    const battle = await updateBattle(battleId, auth.tenantId, parsed.data);
    if (!battle) {
      return c.json({ error: 'バトルが見つかりません' }, 404);
    }
    return c.json(battle);
  } catch (error) {
    if (error instanceof Error) {
      return c.json({ error: error.message }, 400);
    }
    throw error;
  }
});

// バトル削除
battlesRoutes.delete('/battles/:id', async (c) => {
  const auth = c.get('auth');
  const battleId = c.req.param('id');

  try {
    await deleteBattle(battleId, auth.tenantId);
    return c.body(null, 204);
  } catch (error) {
    if (error instanceof Error) {
      return c.json({ error: error.message }, 400);
    }
    throw error;
  }
});

// バトル開始
battlesRoutes.post('/battles/:id/start', async (c) => {
  const auth = c.get('auth');
  const battleId = c.req.param('id');

  try {
    const battle = await startBattle(battleId, auth.tenantId);
    if (!battle) {
      return c.json({ error: 'バトルが見つかりません' }, 404);
    }
    return c.json(battle);
  } catch (error) {
    if (error instanceof Error) {
      return c.json({ error: error.message }, 400);
    }
    throw error;
  }
});

// バトル終了
battlesRoutes.post('/battles/:id/end', async (c) => {
  const auth = c.get('auth');
  const battleId = c.req.param('id');

  try {
    const battle = await endBattle(battleId, auth.tenantId);
    if (!battle) {
      return c.json({ error: 'バトルが見つかりません' }, 404);
    }
    return c.json(battle);
  } catch (error) {
    if (error instanceof Error) {
      return c.json({ error: error.message }, 400);
    }
    throw error;
  }
});

// バトル参加
battlesRoutes.post('/battles/:id/join', async (c) => {
  const auth = c.get('auth');
  const battleId = c.req.param('id');

  try {
    const participant = await joinBattle(battleId, auth.tenantId, auth.userId);
    return c.json(participant, 201);
  } catch (error) {
    if (error instanceof Error) {
      return c.json({ error: error.message }, 400);
    }
    throw error;
  }
});

// バトル退出
battlesRoutes.post('/battles/:id/leave', async (c) => {
  const auth = c.get('auth');
  const battleId = c.req.param('id');

  try {
    await leaveBattle(battleId, auth.tenantId, auth.userId);
    return c.body(null, 204);
  } catch (error) {
    if (error instanceof Error) {
      return c.json({ error: error.message }, 400);
    }
    throw error;
  }
});

// スコア更新
battlesRoutes.post('/battles/:id/score', async (c) => {
  const auth = c.get('auth');
  const battleId = c.req.param('id');

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'リクエストボディが不正です' }, 400);
  }

  const parsed = updateScoreSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: 'バリデーションエラー', details: parsed.error.issues },
      400
    );
  }

  try {
    const participant = await updateScore(
      battleId,
      auth.tenantId,
      auth.userId,
      parsed.data.score
    );
    return c.json(participant);
  } catch (error) {
    if (error instanceof Error) {
      return c.json({ error: error.message }, 400);
    }
    throw error;
  }
});
